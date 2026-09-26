import type { BaselineSnapshot } from "../domain/checks.js";
import type { Mission } from "../domain/mission.js";
import type { BaselineCheckEvidence } from "../project/baselineEvidence.js";
import type { ProjectProfile } from "../project/profile.js";

/**
 * Payload for council intake: profile labels are informational; checks + bounded
 * baselineEvidence are authoritative. Full stdout/stderr stay in CAS.
 */
export function intakeCouncilPayload(
  mission: Mission,
  discovery: ProjectProfile,
  baseline: BaselineSnapshot,
  baselineEvidence: readonly BaselineCheckEvidence[],
): Record<string, unknown> {
  return {
    mission,
    profileHints: {
      kind: "informational",
      packageManager: discovery.packageManager,
      framework: discovery.framework,
      note: "Optional labels from manifests. Do not treat missing packageManager or unknown/node-test framework as blocking when execution evidence exists.",
    },
    execution: {
      kind: "authoritative",
      checks: discovery.checks,
      baseline: { id: baseline.id, runId: baseline.runId, commitHash: baseline.commitHash },
      baselineEvidence,
      mandatoryCommandsDiscovered: discovery.checks.some((check) => check.mandatory && check.command.length > 0),
      baselineExecuted: baseline.checks.length > 0,
      baselineVerdict: baselineVerdict(baseline),
      note: "baselineEvidence already contains command, status, exit, summary, and compact diagnostics loaded from persisted check_output. outputArtifact is a CAS pointer to full stdout/stderr — not missing content. Do not vote needs_human because you only see a sha256, because source files are not inlined, or because a code diff is absent at intake. Workers read the repo later. needs_human is only for genuine mission or product ambiguity that this evidence cannot resolve.",
    },
  };
}

/**
 * One sentence a weak model cannot misread. A live judge voted needs_human for "no
 * baselineEvidence" on a base whose one check had passed: the statuses were there, in a list.
 */
export function baselineVerdict(baseline: BaselineSnapshot): string {
  if (baseline.checks.length === 0) return "no check ran on the base";
  const failing = baseline.checks.filter((check) => check.status !== "pass");
  if (failing.length === 0) return `every check passed on the unchanged base: ${baseline.checks.map((check) => check.name).join(", ")}`;
  return `on the unchanged base, ${failing.map((check) => `${check.name} is ${check.status}`).join(", ")}; ${String(baseline.checks.length - failing.length)} other check(s) passed`;
}
