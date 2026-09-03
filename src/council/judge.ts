import type { RoleOpinion } from "./types.js";

/**
 * Deterministic council aggregation from recorded role votes.
 *
 * 1. Blocking ambiguity on the interpretation always yields NEEDS_HUMAN.
 * 2. Any `needs_human` vote yields NEEDS_HUMAN.
 * 3. A judge `approve` breaks planner/scope_guardian `revise` disagreements → APPROVED.
 * 4. Unanimous `approve` → APPROVED.
 * 5. Otherwise → NEEDS_HUMAN.
 */
export function aggregateCouncilDecision(
  opinions: RoleOpinion[],
  opts?: { blockingAmbiguity?: boolean },
): "APPROVED" | "NEEDS_HUMAN" {
  if (opts?.blockingAmbiguity === true) return "NEEDS_HUMAN";
  if (opinions.some((opinion) => opinion.decision === "needs_human")) return "NEEDS_HUMAN";
  const judge = opinions.find((opinion) => opinion.role === "judge");
  if (judge?.decision === "approve") return "APPROVED";
  if (opinions.every((opinion) => opinion.decision === "approve")) return "APPROVED";
  return "NEEDS_HUMAN";
}
