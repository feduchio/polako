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

export const DISABLED_REASONING = {
  effort: "none",
  exclude: true,
} as const;
