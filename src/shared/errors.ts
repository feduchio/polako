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
  | "BUDGET_EXCEEDED";

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
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
