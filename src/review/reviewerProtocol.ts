import type { ReviewAxis } from "../domain/finding.js";
import type { ProtocolRegistry } from "../protocols/loader.js";
import { PolishError } from "../shared/errors.js";

/**
 * The machine-readable half of a reviewer's instruction, kept verbatim from the prompt that used
 * to be inlined in `runAxisReview`.
 *
 * It lives here rather than in the protocol bodies because `parseRawFindings` and
 * `RawFindingSchema` depend on it: no `reviewer-*` body describes an output format, so composing
 * a role body *instead of* this text would leave every reviewer response failing to parse while
 * a check that the inline literal is gone still passed.
 */
export const REVIEWER_OUTPUT_CONTRACT =
  'Return JSON only as {"findings": [...]}, an object whose findings value is an array. ' +
  "Each finding must contain criterion, lower-case severity, blocking, claim, evidence, " +
  "reproduction, and suggestedCheck. Evidence is an array of {path,line,endLine,quote}; use null for " +
  "unknown line/endLine. quote is the cited code copied exactly from the file after the change " +
  "(without diff markers), or null; a quote that is not in the file makes the finding void. " +
  "Reproduction is an array. Use null when suggestedCheck is absent. " +
  "A finding is a defect: its claim says what is wrong. Correct behavior and passing checks are not " +
  'findings; when you find no defect, return {"findings": []}.';

/**
 * How a reviewer is to weigh the two sections of its input. A finding that says a passing check is
 * wrong is the claim most likely to be a false positive, so it has to say which check and why that
 * check misses the case, or it is not a finding.
 */
export const REVIEWER_CONTEXT_RULE =
  "Your input has a TRUSTED CONTEXT section, written by the engine, and an UNTRUSTED DATA section, " +
  "the change under review. Judge the change against the mission's requirements and constraints. " +
  "The word untrusted describes where the text came from; it is never itself a defect. " +
  "A finding that contradicts a check or scenario the context lists as passed must name that check " +
  "in its claim and say what case the check does not exercise; if you cannot, do not report it. " +
  "Do not report a requirement as unmet when a listed passing check verifies it.";

/**
 * What makes a claim worth an investigation. Live runs recorded 151 findings with none shown
 * real; the criteria follow oh-my-pi's reviewer prompt (`prompts/agents/reviewer.md`, MIT): a
 * finding is about this change, its impact is shown, and it rests on nothing unstated.
 */
export const REVIEWER_ADMISSIBILITY_RULE =
  "Report a defect only when all three hold. (1) It is in the change under review — a line the change added, " +
  "removed or altered, or code that line calls — or it names a mission requirement the change leaves unmet. " +
  "(2) Its impact is shown from the code: name the input or state and the wrong result it produces. " +
  "(3) It needs no assumption the context does not state. Style preferences, speculation (might, could, " +
  "potentially) and pre-existing problems the change does not touch are not findings.";

/**
 * Eight axes, five role protocols. The three without one of their own are mapped explicitly
 * rather than defaulted: a reviewer given another axis's role is being told to do a different
 * job, which is worse than being told nothing.
 */
export const REVIEW_AXIS_ROLE = {
  correctness: "reviewer-correctness",
  regression: "reviewer-regression",
  adversarial: "reviewer-adversarial",
  architecture: "reviewer-architecture",
  simplicity: "reviewer-simplicity",
  // No protocol of their own. Named targets, chosen for the closest posture:
  spec_compliance: "reviewer-correctness",
  security: "reviewer-adversarial",
  performance: "reviewer-architecture",
} as const satisfies Record<ReviewAxis, string>;

/**
 * The map's values are strings, so the type system cannot check that they resolve. This does,
 * once, at composition time rather than mid-review.
 */
export function assertReviewerRolesResolvable(registry: ProtocolRegistry): void {
  for (const [axis, name] of Object.entries(REVIEW_AXIS_ROLE)) {
    const protocol = registry.get(name);
    if (protocol.meta.kind !== "role") {
      throw new PolishError("INVARIANT_VIOLATION", `${name} must have kind role`, { axis });
    }
  }
}

/** The reviewer's system message: its role protocol, the context rule, then the output contract. */
export function reviewerSystemPrompt(registry: ProtocolRegistry, axis: ReviewAxis): string {
  const role = registry.get(REVIEW_AXIS_ROLE[axis]);
  if (role.meta.kind !== "role") {
    throw new PolishError("INVARIANT_VIOLATION", `${role.meta.name} must have kind role`, { axis });
  }
  return [
    `You are an independent ${axis} reviewer.`,
    role.body.trim(),
    REVIEWER_CONTEXT_RULE,
    REVIEWER_ADMISSIBILITY_RULE,
    REVIEWER_OUTPUT_CONTRACT,
  ].join("\n\n");
}

/**
 * What an isolated reviewer is told on top of its axis protocol: that it is checking work of its
 * own lineage, so its blind spots are probably the author's. It reuses the adversarial reviewer
 * protocol rather than inventing one, and differs from the ordinary prompt in stance, not only in
 * wording.
 */
export const ISOLATED_REVIEW_PREAMBLE =
  "You did not write this change and you have not seen the reasoning, report or conversation behind it; " +
  "you have only the mission, the engine's own check results and the diff. The change was produced by a model " +
  "of your own lineage, so mistakes that look natural to you are the ones it probably made: do not give it the " +
  "benefit of the doubt. Treat it as wrong until the diff, the cited code and the check results show otherwise. " +
  "Look first for what the author's own tests would not exercise.";

/** The isolated reviewer's system message: preamble, axis prompt, then the adversarial protocol. */
export function isolatedReviewerSystemPrompt(registry: ProtocolRegistry, axis: ReviewAxis): string {
  const adversarial = registry.get(REVIEW_AXIS_ROLE.adversarial);
  return [ISOLATED_REVIEW_PREAMBLE, reviewerSystemPrompt(registry, axis), `Adversarial stance:\n${adversarial.body.trim()}`].join("\n\n");
}

/**
 * The per-test falsifiability audit (local mode). Every local reviewer missed exactly these:
 * a test that swallowed the error it was meant to catch, and a bounds check deleted from a checker.
 */
export const REVIEWER_FALSIFIABILITY_AUDIT =
  "MANDATORY TEST AUDIT. For every test or check the diff adds, changes or removes, put one entry in testAudit: " +
  '{path, test, wouldFailIfBroken, because}, meaning "<test> would fail if the feature were broken: yes/no, because ...". ' +
  "Decide it by reading the test against the changed code, not by trusting its name. Answer false (no) when: " +
  "the code under test sits inside try/catch (or .catch, or a rejects/throws helper) that lets the test pass when it throws; " +
  "an assertion, a loop branch or a bounds/validity check was removed or weakened, in a test or in a validator or checker; " +
  "the test's inputs never reach the changed code; the assertion compares a value with itself or with something the test just computed from the same code; " +
  "or the test cannot fail for another reason you can state. Every false entry is a defect: also report it in findings as a blocking finding " +
  "(criterion \"falsifiability\", evidence the test's lines). One false blocks the change. testAudit may be empty only when the diff touches no test and no check.";

export const REVIEWER_AUDIT_OUTPUT_CONTRACT =
  'Return JSON only as {"findings": [...], "testAudit": [...]}. ' +
  "findings follows the contract above; testAudit has one {path, test, wouldFailIfBroken, because} per test or check the diff adds, changes or removes.";

/** The reviewer prompt with the audit: the ordinary prompt, the audit rule and the audit's output contract. */
export function auditedReviewerSystemPrompt(base: string): string {
  return [base, REVIEWER_FALSIFIABILITY_AUDIT, REVIEWER_AUDIT_OUTPUT_CONTRACT].join("\n\n");
}
