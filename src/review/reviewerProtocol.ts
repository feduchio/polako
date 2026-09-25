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
  "reproduction, and suggestedCheck. Evidence is an array of {path,line,endLine}; use null for " +
  "unknown line/endLine. Reproduction is an array. Use null when suggestedCheck is absent.";

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
  return [`You are an independent ${axis} reviewer.`, role.body.trim(), REVIEWER_CONTEXT_RULE, REVIEWER_OUTPUT_CONTRACT].join("\n\n");
}
