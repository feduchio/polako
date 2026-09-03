import type { CompletionRequest } from "../broker/types.js";
import type { ModelRef } from "../domain/common.js";
import { modelRefKey } from "../domain/common.js";
import type { NewEvent } from "../domain/event.js";
import type { CouncilRetryConfig } from "../domain/config.js";
import type { Clock } from "../shared/clock.js";
import { PolishError, errorToString } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import { isOperationalFailure, operationalKind } from "./operational.js";
import type { CouncilCompletionClient, CouncilEventSink, CouncilRole } from "./types.js";

export interface AttemptedCouncilModel {
  model: ModelRef;
  kind: string;
  error: string;
}

export interface ResilientCouncilClientOptions {
  inner: CouncilCompletionClient;
  models: readonly ModelRef[];
  role: CouncilRole;
  clock: Clock;
  retry: CouncilRetryConfig;
  eventSink?: CouncilEventSink;
}

/**
 * Walk a user-preference model chain. Fallback only after operational failure of the
 * current model; a successful semantic response is final for that role.
 */
export function createResilientCouncilClient(options: ResilientCouncilClientOptions): CouncilCompletionClient {
  const models = options.models.filter((model) => model.provider.length > 0 && model.model.length > 0);
  if (models.length === 0) {
    throw new PolishError("CONFIG_ERROR", `council role ${options.role} has an empty model chain`);
  }

  return {
    async complete(request) {
      const attempted: AttemptedCouncilModel[] = [];
      let lastError: unknown;
      for (let index = 0; index < models.length; index++) {
        const model = models[index];
        if (model === undefined) continue;
        if (index > 0) {
          const previous = models[index - 1];
          if (previous !== undefined) {
            appendFallback(options, request, previous, model, attempted.at(-1));
          }
        }
        const tagged: CompletionRequest = {
          ...request,
          model,
          metadata: {
            ...request.metadata,
            role: options.role,
            retryPolicy: {
              maxAttempts: options.retry.maxAttemptsPerModel,
              baseDelayMs: options.retry.baseBackoffMs,
              maxDelayMs: options.retry.maxBackoffMs,
            },
          },
        };
        try {
          return await options.inner.complete(tagged);
        } catch (err) {
          lastError = err;
          attempted.push({ model, kind: operationalKind(err), error: errorToString(err) });
          if (!isOperationalFailure(err)) throw err;
        }
      }
      throw new PolishError(
        "PROVIDERS_UNAVAILABLE",
        `council role ${options.role} has no available models`,
        { role: options.role, attempted, models: models.map(modelRefKey) },
        lastError instanceof Error ? { cause: lastError } : undefined,
      );
    },
  };
}

function appendFallback(
  options: ResilientCouncilClientOptions,
  request: CompletionRequest,
  from: ModelRef,
  to: ModelRef,
  lastAttempt: AttemptedCouncilModel | undefined,
): void {
  if (options.eventSink === undefined) return;
  const event: NewEvent = {
    id: id("evt", options.clock.now()),
    runId: request.metadata.runId,
    ts: options.clock.now(),
    type: "model.fallback_selected",
    payload: {
      role: options.role,
      purpose: request.metadata.purpose,
      from,
      to,
      reason: lastAttempt?.kind ?? "operational_failure",
      error: lastAttempt?.error ?? null,
    },
    causedBy: request.metadata.causedBy ?? [],
    actor: { kind: "supervisor", role: options.role, model: to },
    artifacts: [],
  };
  options.eventSink.append([event]);
}
