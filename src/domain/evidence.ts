import { z } from "zod";

/**
 * What an execution showed about a finding. `demonstrated` and `refuted` are earned only by a
 * reproduction observed running; everything else is `not_examined` with the reason, and says
 * nothing about whether the claim is true.
 */
export const EvidenceOutcomeSchema = z.enum(["demonstrated", "refuted", "not_examined"]);
export type EvidenceOutcome = z.infer<typeof EvidenceOutcomeSchema>;

export const NotExaminedReasonSchema = z.enum([
  "reproduction_not_executed",
  "reproduction_broken",
  "killed",
  "timeout",
  "aborted",
  "environment",
  "command_refused",
  "control_failed",
  "failure_outside_reproduction",
  "unrecognised_runner",
  "worker_failed",
  "checkout_failed",
  "no_executable_reproduction",
  "citation_unverifiable",
  "debate_dismissed",
]);
export type NotExaminedReason = z.infer<typeof NotExaminedReasonSchema>;

export interface Evidence {
  outcome: EvidenceOutcome;
  /** Set exactly when `outcome` is `not_examined`. */
  reason: NotExaminedReason | null;
  rationale: string;
}

/** Reasons a model can act on: the investigation is retried once with the reason fed back. */
export const RETRYABLE_REASONS: ReadonlySet<NotExaminedReason> = new Set([
  "reproduction_not_executed",
  "reproduction_broken",
  "unrecognised_runner",
  "command_refused",
]);

export function verdictOfOutcome(outcome: EvidenceOutcome): "VALID" | "REJECTED" | "UNCERTAIN" {
  if (outcome === "demonstrated") return "VALID";
  if (outcome === "refuted") return "REJECTED";
  return "UNCERTAIN";
}

export function demonstrated(rationale: string): Evidence {
  return { outcome: "demonstrated", reason: null, rationale };
}

export function refuted(rationale: string): Evidence {
  return { outcome: "refuted", reason: null, rationale };
}

export function notExamined(reason: NotExaminedReason, rationale: string): Evidence {
  return { outcome: "not_examined", reason, rationale };
}
