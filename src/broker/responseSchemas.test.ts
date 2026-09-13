import { describe, expect, it } from "vitest";
import { EMPIRICAL_SCORE_RESPONSE_SCHEMA, REVIEW_FINDINGS_RESPONSE_SCHEMA } from "./responseSchemas.js";

describe("frozen strict response schemas", () => {
  it("pins every reviewer field independently from the exported object", () => {
    expect(REVIEW_FINDINGS_RESPONSE_SCHEMA).toEqual({
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
                severity: {
                  type: "string",
                  enum: ["critical", "high", "medium", "low", "info"],
                },
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
    });
  });

  it("pins the score schema to two bounded integers and no extras", () => {
    expect(EMPIRICAL_SCORE_RESPONSE_SCHEMA).toEqual({
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
    });
  });
});
