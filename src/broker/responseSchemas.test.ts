import { describe, expect, it } from "vitest";
import {
  DISABLED_REASONING,
  EMPIRICAL_SCORE_RESPONSE_SCHEMA,
  PROGRESS_SCORE_RESPONSE_SCHEMA,
  REVIEW_FINDINGS_RESPONSE_SCHEMA,
  withConfiguredReasoning,
} from "./responseSchemas.js";
import type { CompletionRequest } from "./types.js";

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
                    required: ["path", "line", "endLine", "quote"],
                    properties: {
                      path: { type: "string" },
                      line: { type: ["integer", "null"], minimum: 1 },
                      endLine: { type: ["integer", "null"], minimum: 1 },
                      quote: { type: ["string", "null"] },
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

  it("pins progress to one bounded integer and no extras", () => {
    expect(PROGRESS_SCORE_RESPONSE_SCHEMA).toEqual({
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
    });
  });
});

/**
 * P1.5 AC2. Four input classes because each is a different branch: a one-case check passes for
 * three wrong implementations, including one that overwrites a site's deliberate choice and one
 * that mutates its argument.
 */
describe("withConfiguredReasoning", () => {
  const base = (reasoning?: CompletionRequest["reasoning"]): CompletionRequest => ({
    model: { provider: "p", model: "m" },
    messages: [{ role: "user", content: "hi" }],
    metadata: { runId: "run_1", purpose: "probe", role: "worker" },
    ...(reasoning === undefined ? {} : { reasoning }),
  });

  it("returns the request itself when the flag is off", () => {
    const request = base();
    expect(withConfiguredReasoning(request, false)).toBe(request);
    expect("reasoning" in request).toBe(false);
  });

  it("returns the request itself when the flag is off and the site chose its own", () => {
    const request = base(DISABLED_REASONING);
    expect(withConfiguredReasoning(request, false)).toBe(request);
  });

  it("adds the disabled reasoning as a copy when the flag is on", () => {
    const request = base();
    const out = withConfiguredReasoning(request, true);
    expect(out).not.toBe(request);
    expect(out.reasoning).toEqual({ effort: "none", exclude: true });
    // The caller's object is shared across the loop; mutating it would leak into later turns.
    expect("reasoning" in request).toBe(false);
  });

  it("leaves a site's own choice alone when the flag is on", () => {
    const own = { effort: "high", exclude: false } as const;
    const request = base(own);
    expect(withConfiguredReasoning(request, true)).toBe(request);
    expect(request.reasoning).toBe(own);
  });
});
