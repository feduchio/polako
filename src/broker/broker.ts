import { modelRefKey } from "../domain/common.js";
import type { NewEvent } from "../domain/event.js";
import type { Store } from "../store/index.js";
import type { Clock } from "../shared/clock.js";
import { PolishError, errorToString, isAbortError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import type { ModelCatalog } from "./catalog.js";
import { foldModelCallUsage, budgetSnapshotFromUsage } from "../convergence/pathology/budget.js";
import type { BudgetSnapshot } from "./quota.js";
import type { BudgetTracker, QuotaTracker } from "./quota.js";
import type { SecretStore } from "./secrets.js";
import { ProviderError, isAccountScopedLimit, taskBudgetKey, type CompletionRequest, type CompletionResponse, type ProviderAdapter } from "./types.js";
import { ModelObservationRepository } from "./observations.js";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 30_000 };

/**
 * Output allowance assumed when neither the request nor the catalogue states one. A reservation
 * that understates is the defect; this is deliberately generous rather than typical.
 */
const UNSTATED_OUTPUT_ALLOWANCE = 8192;

export interface BrokerDeps {
  store: Store;
  clock: Clock;
  catalog: ModelCatalog;
  quota: QuotaTracker;
  budget: BudgetTracker;
  secrets: SecretStore;
  retry?: RetryPolicy;
  /** deterministic jitter for tests */
  jitter?: () => number;
  observations?: ModelObservationRepository;
}

export interface ModelCallRecord {
  eventId: string;
  response: CompletionResponse;
  attempts: number;
  callId: string;
}

interface AttemptOutcome {
  ok: boolean;
  latencyMs: number;
  errorKind?: string;
  at: number;
}

/**
 * The single entry point for LLM calls. Enforces budgets and quotas, retries retryable
 * provider errors with backoff, records every call (request + response as artifacts,
 * redacted) as a `model.call` event, and feeds latency/failure stats to the catalog.
 */
export class ModelBroker {
  private readonly retry: RetryPolicy;
  private readonly jitter: () => number;
  private readonly observations: ModelObservationRepository;

  constructor(private readonly deps: BrokerDeps) {
    this.retry = deps.retry ?? DEFAULT_RETRY_POLICY;
    this.jitter = deps.jitter ?? Math.random;
    this.observations = deps.observations ?? new ModelObservationRepository(deps.store);
  }

  async complete(request: CompletionRequest): Promise<ModelCallRecord> {
    const adapter = this.deps.catalog.provider(request.model.provider);
    if (!adapter) throw new PolishError("CONFIG_ERROR", `unknown provider ${request.model.provider}`);
    // One hold per provider invocation, not per call: the retry loop makes up to `maxAttempts` of
    // them, and a failed attempt records no usage, so a single hold would cover the first and let
    // the rest through unpriced. Released in `finally`, which runs after `attempt` has evaluated
    // its return value and so after `budget.record`: releasing earlier leaves a window in which
    // the call counts nowhere.
    const estimate = this.estimatedCostUsd(request);
    const admit = (): (() => void) =>
      this.deps.budget.admit(request.metadata.runId, estimate, taskBudgetKey(request.metadata.taskId, request.metadata.taskAttempt));
    const releases = [admit()];
    try {
      return await this.attempt(request, adapter, () => {
        releases.push(admit());
      });
    } finally {
      for (const release of releases) release();
    }
  }

  /**
   * What one attempt is admitted against: everything the request will put on the wire, priced at
   * what the catalogue advertises.
   *
   * Deliberately pessimistic, and **not a proven upper bound**. A token is at least one character,
   * so one token per character over-counts ordinary prose by about four; it still understates text
   * that tokenizes badly, and JSON-heavy messages have been measured at 1.15 characters per token.
   * The guarantee this item makes is about concurrency — that N calls in flight are not all
   * admitted against the same figure — not about exactness. Unknown prices reserve nothing,
   * because such a call cannot raise `runUsd` either; that gap is `unknownCostCalls`, R6's.
   */
  private estimatedCostUsd(request: CompletionRequest): number {
    const capabilities = this.deps.catalog.get(request.model)?.info.capabilities;
    if (capabilities === undefined) return 0;
    const { inputCostPerM, outputCostPerM } = capabilities;
    if (inputCostPerM === null || outputCostPerM === null) return 0;
    // Tools and the response schema are sent too (`openaiCompat.ts` builds them into the payload)
    // and a review request's schema is not small.
    const sent = JSON.stringify([request.messages, request.tools ?? [], request.responseSchema ?? null]);
    const outputTokens = request.maxTokens ?? capabilities.maxOutputTokens ?? UNSTATED_OUTPUT_ALLOWANCE;
    return (sent.length * inputCostPerM + outputTokens * outputCostPerM) / 1_000_000;
  }

  private async attempt(
    request: CompletionRequest,
    adapter: ProviderAdapter,
    admitRetry: () => void,
  ): Promise<ModelCallRecord> {
    const { catalog, quota, budget, clock } = this.deps;
    const retry = request.metadata.retryPolicy ?? this.retry;
    const callId = request.metadata.callId ?? id("call", clock.now());
    const tagged: CompletionRequest = {
      ...request,
      metadata: { ...request.metadata, callId, retryPolicy: retry },
    };

    let attempt = 0;
    let lastError: unknown;
    const outcomes: AttemptOutcome[] = [];

    this.recordStarted(tagged, callId);

    const failCancelled = (err: unknown): never => {
      // attempts = real provider invocations only (outcomes), not cancelled waits
      this.recordEvent(tagged, null, Math.max(outcomes.length, 1), outcomes, errorToString(err), budget.snapshot(tagged.metadata.runId).runUsd, callId);
      throw err instanceof PolishError ? err : new PolishError("CANCELLED", "model call cancelled", { cause: err });
    };

    const isCancel = (err: unknown): boolean =>
      isAbortError(err) || (err instanceof PolishError && err.code === "CANCELLED");

    while (attempt < retry.maxAttempts) {
      attempt++;
      // The first invocation's hold was taken by the caller, before any work started. A refusal
      // here arrives after `model.call_started`, so it has to close the call the way every other
      // terminal error does: a started call without a terminal `model.call` is a call that no
      // report, no cost query and no operator can account for.
      if (attempt > 1) {
        try {
          admitRetry();
        } catch (err) {
          this.recordEvent(tagged, null, Math.max(outcomes.length, 1), outcomes, errorToString(err), budget.snapshot(tagged.metadata.runId).runUsd, callId);
          throw err;
        }
      }
      if (tagged.signal?.aborted) {
        failCancelled(new PolishError("CANCELLED", "model call cancelled"));
      }
      let release: () => void;
      try {
        release = await quota.acquire(adapter.id, tagged.signal);
      } catch (err) {
        if (isCancel(err)) failCancelled(err);
        throw err;
      }
      if (tagged.signal?.aborted) {
        release();
        failCancelled(new PolishError("CANCELLED", "model call cancelled"));
      }
      const started = clock.now();
      try {
        const response = await adapter.complete(tagged);
        release();
        const latency = Math.max(0, clock.now() - started) || response.latencyMs;
        const outcome: AttemptOutcome = { ok: true, latencyMs: latency, at: clock.now() };
        outcomes.push(outcome);
        this.recordRoutingStats(tagged, outcome);
        const snapshot = budget.record(tagged.metadata.runId, response.usage, taskBudgetKey(tagged.metadata.taskId, tagged.metadata.taskAttempt), callId);
        const eventId = this.recordEvent(tagged, response, attempt, outcomes, null, snapshot.runUsd, callId);
        return { eventId, response, attempts: attempt, callId };
      } catch (err) {
        release();
        lastError = err;
        const kind = isCancel(err) ? "cancelled" : err instanceof ProviderError ? err.kind : "unknown";
        const outcome: AttemptOutcome = { ok: false, latencyMs: clock.now() - started, errorKind: kind, at: clock.now() };
        outcomes.push(outcome);
        this.recordRoutingStats(tagged, outcome, err);
        if (isCancel(err)) {
          this.recordEvent(tagged, null, attempt, outcomes, errorToString(err), budget.snapshot(tagged.metadata.runId).runUsd, callId);
          throw err;
        }
        if (err instanceof ProviderError && err.kind === "rate_limit") {
          quota.coolDown(adapter.id, err.retryAfterMs ?? this.backoff(attempt, retry));
        }
        const retryable = err instanceof ProviderError ? err.retryable : false;
        if (!retryable || attempt >= retry.maxAttempts) {
          this.recordEvent(tagged, null, attempt, outcomes, errorToString(err), budget.snapshot(tagged.metadata.runId).runUsd, callId);
          if (err instanceof ProviderError && err.kind === "auth") catalog.setProviderAvailable(adapter.id, false);
          throw err;
        }
        const delayMs =
          err instanceof ProviderError && err.retryAfterMs !== null ? err.retryAfterMs : this.backoff(attempt, retry);
        this.recordRetryScheduled(tagged, callId, attempt, retry.maxAttempts, delayMs, kind);
        try {
          await clock.sleep(delayMs, tagged.signal);
        } catch (sleepErr) {
          // Cancel during backoff: keep the failed attempt outcome only; do not invent another call.
          if (isCancel(sleepErr)) failCancelled(sleepErr);
          throw sleepErr;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new PolishError("PROVIDER_ERROR", "model call failed");
  }

  /**
   * A capability probe asks whether a model can do a thing. Its outcome is not an observation of
   * how well the model serves work, and the commonest probe failure — the account is out of free
   * requests for the day — is a property of the account, not of the model it happened to hit. Nine
   * models probed under one exhausted quota would otherwise each carry a routing penalty for it.
   * The probe's own verdict is recorded by the discovery driver, as `model.probed`.
   */
  private recordRoutingStats(request: CompletionRequest, outcome: AttemptOutcome, error?: unknown): void {
    if (request.metadata.role === "probe") return;
    // The account's allowance is spent. Charging that to whichever model happened to ask is how a
    // whole ensemble ends up down-ranked for one condition none of them caused.
    if (isAccountScopedLimit(error)) return;
    this.deps.catalog.recordCall(request.model, outcome);
    this.observations.recordCall(request.model, outcome, request.metadata.runId);
  }

  private backoff(attempt: number, retry: RetryPolicy = this.retry): number {
    const exp = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exp * (0.5 + this.jitter() * 0.5));
  }

  private recordStarted(request: CompletionRequest, callId: string): void {
    const { store, clock } = this.deps;
    const event: NewEvent = {
      id: id("evt", clock.now()),
      runId: request.metadata.runId,
      ts: clock.now(),
      type: "model.call_started",
      payload: {
        callId,
        model: request.model,
        role: request.metadata.role,
        purpose: request.metadata.purpose,
        taskId: request.metadata.taskId ?? null,
      },
      causedBy: request.metadata.causedBy ?? [],
      actor: { kind: roleToActorKind(request.metadata.role), role: request.metadata.role, model: request.model },
      artifacts: [],
    };
    store.events.append([event]);
  }

  private recordRetryScheduled(
    request: CompletionRequest,
    callId: string,
    attempt: number,
    maxAttempts: number,
    delayMs: number,
    errorKind: string,
  ): void {
    const { store, clock } = this.deps;
    const event: NewEvent = {
      id: id("evt", clock.now()),
      runId: request.metadata.runId,
      ts: clock.now(),
      type: "model.retry_scheduled",
      payload: {
        callId,
        model: request.model,
        role: request.metadata.role,
        purpose: request.metadata.purpose,
        attempt,
        maxAttempts,
        delayMs,
        errorKind,
        retryAt: clock.now() + delayMs,
      },
      causedBy: request.metadata.causedBy ?? [],
      actor: { kind: roleToActorKind(request.metadata.role), role: request.metadata.role, model: request.model },
      artifacts: [],
    };
    store.events.append([event]);
  }

  private recordEvent(
    request: CompletionRequest,
    response: CompletionResponse | null,
    attempts: number,
    attemptOutcomes: readonly AttemptOutcome[],
    error: string | null,
    runUsdSoFar: number,
    callId: string,
  ): string {
    const { store, secrets, clock } = this.deps;
    const reqArtifact = store.artifacts.put(
      secrets.redact(
        JSON.stringify(
          {
            model: request.model,
            messages: request.messages,
            tools: request.tools,
            responseFormat: request.responseFormat,
            responseSchema: request.responseSchema ?? null,
            reasoning: request.reasoning ?? null,
            retryPolicy: request.metadata.retryPolicy ?? null,
            maxTokens: request.maxTokens ?? null,
            temperature: request.temperature ?? null,
          },
          null,
          0,
        ),
      ),
      "model_request",
      `${modelRefKey(request.model)} ${request.metadata.purpose}`,
    );
    const artifacts = [reqArtifact];
    if (response) artifacts.push(store.artifacts.put(secrets.redact(JSON.stringify(response)), "model_response", modelRefKey(request.model)));
    const event: NewEvent = {
      id: id("evt", clock.now()),
      runId: request.metadata.runId,
      ts: clock.now(),
      type: "model.call",
      payload: {
        callId,
        model: request.model,
        role: request.metadata.role,
        purpose: request.metadata.purpose,
        taskId: request.metadata.taskId ?? null,
        ...(request.metadata.taskAttempt === undefined ? {} : { taskAttempt: request.metadata.taskAttempt }),
        attempts,
        retryPolicy: request.metadata.retryPolicy ?? null,
        attemptOutcomes,
        ok: response !== null,
        error,
        usage: response?.usage ?? null,
        finishReason: response?.finishReason ?? null,
        latencyMs: response?.latencyMs ?? null,
        runUsdSoFar,
      },
      causedBy: request.metadata.causedBy ?? [],
      actor: { kind: roleToActorKind(request.metadata.role), role: request.metadata.role, model: request.model },
      artifacts,
    };
    const [stored] = store.events.append([event]);
    return stored?.id ?? event.id;
  }

  /** A run's current spend, as the tracker holds it. The read companion to `restore`. */
  budgetSnapshot(runId: string): BudgetSnapshot {
    return this.deps.budget.snapshot(runId);
  }

  /** Rebuild budget usage and catalog stats for a run from its `model.call` events. */
  restore(runId: string): void {
    const { store, budget, catalog } = this.deps;
    // Global observations must be replayed before catalog registration/refresh can safely consume them.
    this.observations.restoreCatalog(catalog);
    const usage = foldModelCallUsage(store.events.list(runId, { types: ["model.call"] }));
    budget.restore(runId, budgetSnapshotFromUsage(usage));
  }
}

function roleToActorKind(role: string): "supervisor" | "worker" | "reviewer" | "verifier" | "evidence_agent" | "prosecutor" | "defender" | "judge" | "scout" | "system" {
  switch (role) {
    case "supervisor":
    case "planner":
    case "scope_guardian":
      return "supervisor";
    case "judge":
      return "judge";
    case "worker":
      return "worker";
    case "reviewer":
      return "reviewer";
    case "verifier":
      return "verifier";
    case "evidence":
      return "evidence_agent";
    case "prosecutor":
      return "prosecutor";
    case "defender":
      return "defender";
    case "scout":
      return "scout";
    default:
      return "system";
  }
}
