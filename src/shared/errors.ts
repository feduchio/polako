export type PolishErrorCode =
  | "INVALID_TRANSITION"
  | "INVARIANT_VIOLATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CANCELLED"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "SANDBOX_ERROR"
  | "CONFIG_ERROR"
  | "IO_ERROR"
  | "INVALID_ARGUMENT"
  | "BUDGET_EXCEEDED"
  | "PROVIDERS_UNAVAILABLE"
  | "OUTPUT_CONTRACT";

export class PolishError extends Error {
  readonly code: PolishErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: PolishErrorCode, message: string, details: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolishError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition: unknown, message: string, details?: Record<string, unknown>): asserts condition {
  if (!condition) throw new PolishError("INVARIANT_VIOLATION", message, details);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || (err instanceof PolishError && err.code === "CANCELLED"));
}

export function errorToString(err: unknown): string {
  // The code is the part a caller can branch on and an operator can search for; `name` is always
  // "PolishError" and carries nothing.
  if (err instanceof PolishError) return `${err.name}[${err.code}]: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function isProvidersUnavailable(err: unknown): boolean {
  return err instanceof PolishError && err.code === "PROVIDERS_UNAVAILABLE";
}

export function isOutputContractFailure(err: unknown): boolean {
  return err instanceof PolishError && err.code === "OUTPUT_CONTRACT";
}

/** Exhausted council availability or planner output-contract failure: pause, do not ask a human. */
export function isResumableCouncilFailure(err: unknown): boolean {
  return isProvidersUnavailable(err) || isOutputContractFailure(err);
}
