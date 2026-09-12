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
  "Return JSON only as an array of findings. " +
  "Each finding must contain criterion, severity, blocking, claim, evidence " +
  "(path and optional line/endLine), reproduction, and optional suggestedCheck.";

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

/** The reviewer's system message: its role protocol, then the output contract. */
export function reviewerSystemPrompt(registry: ProtocolRegistry, axis: ReviewAxis): string {
  const role = registry.get(REVIEW_AXIS_ROLE[axis]);
  if (role.meta.kind !== "role") {
    throw new PolishError("INVARIANT_VIOLATION", `${role.meta.name} must have kind role`, { axis });
  }
  return [`You are an independent ${axis} reviewer.`, role.body.trim(), REVIEWER_OUTPUT_CONTRACT].join("\n\n");
}
