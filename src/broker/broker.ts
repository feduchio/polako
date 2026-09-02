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
    while (attempt < this.retry.maxAttempts) {
      attempt++;
      if (request.signal?.aborted) throw new PolishError("CANCELLED", "model call cancelled");
      const release = await quota.acquire(adapter.id, request.signal);
      const started = clock.now();
      try {
        const response = await adapter.complete(request);
        release();
        const latency = Math.max(0, clock.now() - started) || response.latencyMs;
        catalog.recordCall(request.model, { ok: true, latencyMs: latency, at: clock.now() });
        const snapshot = budget.record(request.metadata.runId, response.usage, request.metadata.taskId);
        const eventId = this.recordEvent(request, response, attempt, null, snapshot.runUsd);
        return { eventId, response, attempts: attempt };
      } catch (err) {
        release();
        lastError = err;
        if (isAbortError(err)) throw err;
        const kind = err instanceof ProviderError ? err.kind : "unknown";
        catalog.recordCall(request.model, { ok: false, latencyMs: clock.now() - started, errorKind: kind, at: clock.now() });
        if (err instanceof ProviderError && err.kind === "rate_limit") {
          quota.coolDown(adapter.id, err.retryAfterMs ?? this.backoff(attempt));
        }
        const retryable = err instanceof ProviderError ? err.retryable : false;
        if (!retryable || attempt >= this.retry.maxAttempts) {
          this.recordEvent(request, null, attempt, errorToString(err), budget.snapshot(request.metadata.runId).runUsd);
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
    error: string | null,
    runUsdSoFar: number,
  ): string {
    const { store, secrets, clock } = this.deps;
    const reqArtifact = store.artifacts.put(
      secrets.redact(JSON.stringify({ model: request.model, messages: request.messages, tools: request.tools, responseFormat: request.responseFormat }, null, 0)),
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
    const snapshot = { runUsd: 0, runTokens: 0, perTask: {} as Record<string, number> };
    for (const e of store.events.list(runId, { types: ["model.call"] })) {
      const p = e.payload as {
        model?: { provider: string; model: string };
        ok?: boolean;
        usage?: { inputTokens: number; outputTokens: number; costUsd: number | null } | null;
        latencyMs?: number | null;
        taskId?: string | null;
        error?: string | null;
      };
      if (p.model) {
        const outcome: Parameters<ModelCatalog["recordCall"]>[1] = { ok: p.ok === true, latencyMs: p.latencyMs ?? 0, at: e.ts };
        if (p.error) outcome.errorKind = p.error;
        catalog.recordCall(p.model, outcome);
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
