import type { BaselineSnapshot } from "../domain/checks.js";
import type { Ambiguity, Mission } from "../domain/mission.js";
import type { ProjectProfile } from "../project/profile.js";
import type { RoleOpinion } from "./types.js";

const PROFILE_HINT_RE =
  /framework\s*[=:]?\s*['"]?unknown['"]?|packageManager\s*[=:]?\s*['"]?null['"]?/i;
const INTAKE_NOOP_RE = /no-op diff|noop diff|no code (exists|yet)|during intake/i;

function isNonBlockingIntakeNoise(text: string): boolean {
  return isInformationalProfileHintText(text) || INTAKE_NOOP_RE.test(text);
}

/** Optional labels from manifests. Absence is not execution uncertainty. */
export function isInformationalProfileHintText(text: string): boolean {
  return PROFILE_HINT_RE.test(text);
}

export function executionEvidenceIsSufficient(
  discovery: ProjectProfile,
  baseline: BaselineSnapshot,
): boolean {
  const mandatory = discovery.checks.filter((check) => check.mandatory && check.command.length > 0);
  if (mandatory.length === 0) return false;
  const names = new Set(mandatory.map((check) => check.name));
  return baseline.checks.some((check) => names.has(check.name));
}

/**
 * Payload for council intake: profile labels are informational; check commands + baseline are authoritative.
 */
export function intakeCouncilPayload(
  mission: Mission,
  discovery: ProjectProfile,
  baseline: BaselineSnapshot,
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
      baseline,
      mandatoryCommandsDiscovered: discovery.checks.some((check) => check.mandatory && check.command.length > 0),
      baselineExecuted: baseline.checks.length > 0,
      note: "Discovered mandatory check commands and baseline results are the execution evidence. A successful or failed baseline run means the test command is executable.",
    },
  };
}

/** Drop needs_human votes that are only about missing profile hints when checks already ran. */
export function neutralizeInformationalProfileVotes(
  opinions: readonly RoleOpinion[],
  discovery: ProjectProfile,
  baseline: BaselineSnapshot,
): RoleOpinion[] {
  if (!executionEvidenceIsSufficient(discovery, baseline)) return [...opinions];
  return opinions.map((opinion) => {
    if (opinion.decision !== "needs_human" && opinion.decision !== "revise") return opinion;
    const leftover = opinion.concerns.filter((concern) => !isNonBlockingIntakeNoise(concern));
    const rationaleIsNoise = isNonBlockingIntakeNoise(opinion.rationale);
    if (leftover.length === 0 && (rationaleIsNoise || opinion.concerns.length > 0)) {
      return { ...opinion, decision: "approve", concerns: [] };
    }
    if (leftover.length !== opinion.concerns.length) return { ...opinion, concerns: leftover };
    return opinion;
  });
}

export function neutralizeInformationalAmbiguities(
  ambiguities: readonly Ambiguity[],
  discovery: ProjectProfile,
  baseline: BaselineSnapshot,
): Ambiguity[] {
  if (!executionEvidenceIsSufficient(discovery, baseline)) return [...ambiguities];
  return ambiguities.map((ambiguity) => {
    if (!ambiguity.blocking) return ambiguity;
    if (!isInformationalProfileHintText(ambiguity.question)) return ambiguity;
    return { ...ambiguity, blocking: false };
  });
}
