import { modelRefKey } from "../domain/common.js";
import type { NewEvent } from "../domain/event.js";
import type { Store } from "../store/index.js";
import type { Clock } from "../shared/clock.js";
import { PolishError, errorToString, isAbortError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import type { ModelCatalog } from "./catalog.js";
import type { BudgetTracker, QuotaTracker } from "./quota.js";
import type { SecretStore } from "./secrets.js";
import { ProviderError, type CompletionRequest, type CompletionResponse } from "./types.js";

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
}

export interface ModelCallRecord {
  eventId: string;
  response: CompletionResponse;
  attempts: number;
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

  constructor(private readonly deps: BrokerDeps) {
    this.retry = deps.retry ?? DEFAULT_RETRY_POLICY;
    this.jitter = deps.jitter ?? Math.random;
  }

  async complete(request: CompletionRequest): Promise<ModelCallRecord> {
    const { catalog, quota, budget, clock } = this.deps;
    const adapter = catalog.provider(request.model.provider);
    if (!adapter) throw new PolishError("CONFIG_ERROR", `unknown provider ${request.model.provider}`);
    budget.assertWithin(request.metadata.runId, request.metadata.taskId);

    let attempt = 0;
    let lastError: unknown;
    const outcomes: AttemptOutcome[] = [];

    const failCancelled = (err: unknown): never => {
      this.recordEvent(request, null, Math.max(attempt, 1), outcomes, errorToString(err), budget.snapshot(request.metadata.runId).runUsd);
      throw err instanceof PolishError ? err : new PolishError("CANCELLED", "model call cancelled", { cause: err });
    };

    while (attempt < this.retry.maxAttempts) {
      attempt++;
      if (request.signal?.aborted) {
        outcomes.push({ ok: false, latencyMs: 0, errorKind: "cancelled", at: clock.now() });
        catalog.recordCall(request.model, { ok: false, latencyMs: 0, errorKind: "cancelled", at: clock.now() });
        failCancelled(new PolishError("CANCELLED", "model call cancelled"));
      }
      const release = await quota.acquire(adapter.id, request.signal);
      if (request.signal?.aborted) {
        release();
        outcomes.push({ ok: false, latencyMs: 0, errorKind: "cancelled", at: clock.now() });
        catalog.recordCall(request.model, { ok: false, latencyMs: 0, errorKind: "cancelled", at: clock.now() });
        failCancelled(new PolishError("CANCELLED", "model call cancelled"));
      }
      const started = clock.now();
      try {
        const response = await adapter.complete(request);
        release();
        const latency = Math.max(0, clock.now() - started) || response.latencyMs;
        const outcome: AttemptOutcome = { ok: true, latencyMs: latency, at: clock.now() };
        outcomes.push(outcome);
        catalog.recordCall(request.model, outcome);
        const snapshot = budget.record(request.metadata.runId, response.usage, request.metadata.taskId);
        const eventId = this.recordEvent(request, response, attempt, outcomes, null, snapshot.runUsd);
        return { eventId, response, attempts: attempt };
      } catch (err) {
        release();
        lastError = err;
        const kind = isAbortError(err)
          ? "cancelled"
          : err instanceof ProviderError
            ? err.kind
            : "unknown";
        const outcome: AttemptOutcome = { ok: false, latencyMs: clock.now() - started, errorKind: kind, at: clock.now() };
        outcomes.push(outcome);
        catalog.recordCall(request.model, outcome);
        if (isAbortError(err) || (err instanceof PolishError && err.code === "CANCELLED")) {
          this.recordEvent(request, null, attempt, outcomes, errorToString(err), budget.snapshot(request.metadata.runId).runUsd);
          throw err;
        }
        if (err instanceof ProviderError && err.kind === "rate_limit") {
          quota.coolDown(adapter.id, err.retryAfterMs ?? this.backoff(attempt));
        }
        const retryable = err instanceof ProviderError ? err.retryable : false;
        if (!retryable || attempt >= this.retry.maxAttempts) {
          this.recordEvent(request, null, attempt, outcomes, errorToString(err), budget.snapshot(request.metadata.runId).runUsd);
          if (err instanceof ProviderError && err.kind === "auth") catalog.setProviderAvailable(adapter.id, false);
          throw err;
        }
        await clock.sleep(err instanceof ProviderError && err.retryAfterMs !== null ? err.retryAfterMs : this.backoff(attempt), request.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new PolishError("PROVIDER_ERROR", "model call failed");
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exp * (0.5 + this.jitter() * 0.5));
  }

  private recordEvent(
    request: CompletionRequest,
    response: CompletionResponse | null,
    attempts: number,
    attemptOutcomes: readonly AttemptOutcome[],
    error: string | null,
    runUsdSoFar: number,
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
    catalog.resetCallStats();
    const snapshot = { runUsd: 0, runTokens: 0, perTask: {} as Record<string, number> };
    for (const e of store.events.list(runId, { types: ["model.call"] })) {
      const p = e.payload as {
        model?: { provider: string; model: string };
        ok?: boolean;
        usage?: { inputTokens: number; outputTokens: number; costUsd: number | null } | null;
        latencyMs?: number | null;
        taskId?: string | null;
        error?: string | null;
        attemptOutcomes?: AttemptOutcome[];
        attempts?: number;
      };
      if (p.model) {
        if (p.attemptOutcomes && p.attemptOutcomes.length > 0) {
          for (const o of p.attemptOutcomes) {
            const outcome: Parameters<ModelCatalog["recordCall"]>[1] = { ok: o.ok, latencyMs: o.latencyMs, at: o.at };
            if (o.errorKind !== undefined) outcome.errorKind = o.errorKind;
            catalog.recordCall(p.model, outcome);
          }
        } else {
          const outcome: Parameters<ModelCatalog["recordCall"]>[1] = { ok: p.ok === true, latencyMs: p.latencyMs ?? 0, at: e.ts };
          if (p.error) outcome.errorKind = p.error;
          catalog.recordCall(p.model, outcome);
        }
      }
      if (p.usage) {
        const tokens = p.usage.inputTokens + p.usage.outputTokens;
        snapshot.runTokens += tokens;
        snapshot.runUsd += p.usage.costUsd ?? 0;
        if (p.taskId) snapshot.perTask[p.taskId] = (snapshot.perTask[p.taskId] ?? 0) + tokens;
      }
    }
    budget.restore(runId, snapshot);
  }
}

function roleToActorKind(role: string): "supervisor" | "worker" | "reviewer" | "verifier" | "evidence_agent" | "scout" | "system" {
  switch (role) {
    case "supervisor":
    case "judge":
      return "supervisor";
    case "worker":
      return "worker";
    case "reviewer":
      return "reviewer";
    case "verifier":
      return "verifier";
    case "evidence":
      return "evidence_agent";
    case "scout":
      return "scout";
    default:
      return "system";
  }
}
