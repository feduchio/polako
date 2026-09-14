import type { CompletionRequest } from "./types.js";

export const REVIEW_FINDINGS_RESPONSE_SCHEMA = {
  name: "review_findings",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "criterion",
            "severity",
            "blocking",
            "claim",
            "evidence",
            "reproduction",
            "suggestedCheck",
          ],
          properties: {
            criterion: { type: "string" },
            severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
            blocking: { type: "boolean" },
            claim: { type: "string" },
            evidence: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "line", "endLine"],
                properties: {
                  path: { type: "string" },
                  line: { type: ["integer", "null"], minimum: 1 },
                  endLine: { type: ["integer", "null"], minimum: 1 },
                },
              },
            },
            reproduction: { type: "array", items: { type: "string" } },
            suggestedCheck: { type: ["string", "null"] },
          },
        },
      },
    },
  },
} as const;

export const EMPIRICAL_SCORE_RESPONSE_SCHEMA = {
  name: "empirical_pair_score",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["scoreA", "scoreB"],
    properties: {
      scoreA: { type: "integer", minimum: 0, maximum: 4 },
      scoreB: { type: "integer", minimum: 0, maximum: 4 },
    },
  },
} as const;

export const PROGRESS_SCORE_RESPONSE_SCHEMA = {
  name: "agent_progress_score",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["progress"],
    properties: {
      progress: { type: "integer", minimum: 0, maximum: 4 },
    },
  },
} as const;

export const DISABLED_REASONING = {
  effort: "none",
  exclude: true,
} as const;

/**
 * Applies `routing.disableReasoning` to one request. The worker loop and the council both call
 * this, so the two sites cannot drift on what the flag means.
 *
 * A request that already carries a `reasoning` of its own is returned untouched. The reviewers and
 * the progress tracker disable it deliberately and unconditionally; a policy flag that overwrote an
 * explicit choice would make a future disagreement between the two invisible.
 */
export function withConfiguredReasoning(request: CompletionRequest, disable: boolean): CompletionRequest {
  if (!disable || request.reasoning !== undefined) return request;
  return { ...request, reasoning: DISABLED_REASONING };
}
