import { modelRefKey } from "../domain/common.js";
import type { NewEvent } from "../domain/event.js";
import type { Store } from "../store/index.js";
import type { Clock } from "../shared/clock.js";
import { PolishError, errorToString, isAbortError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import type { ModelCatalog } from "./catalog.js";
import { foldModelCallUsage, budgetSnapshotFromUsage } from "../convergence/pathology/budget.js";
import type { BudgetTracker, QuotaTracker } from "./quota.js";
import type { SecretStore } from "./secrets.js";
import { ProviderError, type CompletionRequest, type CompletionResponse } from "./types.js";
import { ModelObservationRepository } from "./observations.js";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 30_000 };

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
    const { catalog, quota, budget, clock } = this.deps;
    const adapter = catalog.provider(request.model.provider);
    if (!adapter) throw new PolishError("CONFIG_ERROR", `unknown provider ${request.model.provider}`);
    budget.assertWithin(request.metadata.runId, request.metadata.taskId);

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
        catalog.recordCall(tagged.model, outcome);
        this.observations.recordCall(tagged.model, outcome, tagged.metadata.runId);
        const snapshot = budget.record(tagged.metadata.runId, response.usage, tagged.metadata.taskId, callId);
        const eventId = this.recordEvent(tagged, response, attempt, outcomes, null, snapshot.runUsd, callId);
        return { eventId, response, attempts: attempt, callId };
      } catch (err) {
        release();
        lastError = err;
        const kind = isCancel(err) ? "cancelled" : err instanceof ProviderError ? err.kind : "unknown";
        const outcome: AttemptOutcome = { ok: false, latencyMs: clock.now() - started, errorKind: kind, at: clock.now() };
        outcomes.push(outcome);
        catalog.recordCall(tagged.model, outcome);
        this.observations.recordCall(tagged.model, outcome, tagged.metadata.runId);
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
        attempts,
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
