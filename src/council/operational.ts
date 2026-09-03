import { ProviderError } from "../broker/types.js";
import { isOutputContractFailure, PolishError } from "../shared/errors.js";

/**
 * Infrastructure failures that may use an authorised fallback model.
 * Semantic answers (including inconvenient ones) are never operational failures.
 */
export function isOperationalFailure(err: unknown): boolean {
  if (err instanceof ProviderError) {
    return err.kind !== "bad_request" && err.kind !== "context_length";
  }
  if (err instanceof PolishError) {
    return err.code === "PROVIDER_ERROR" || err.code === "TIMEOUT" || err.code === "PROVIDERS_UNAVAILABLE";
  }
  if (err instanceof Error && err.name === "AbortError") return false;
  return false;
}

/** Schema/JSON contract failures may use the authorised model chain; they are not semantic answers. */
export function isCouncilFallbackWorthy(err: unknown): boolean {
  return isOperationalFailure(err) || isOutputContractFailure(err);
}

export function operationalKind(err: unknown): string {
  if (err instanceof ProviderError) return err.kind;
  if (err instanceof PolishError) return err.code.toLowerCase();
  if (err instanceof Error) return err.name;
  return "unknown";
}
