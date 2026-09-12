import { ReviewAxisSchema } from "../domain/finding.js";
import { REVIEW_AXIS_ROLE, assertReviewerRolesResolvable } from "./reviewerProtocol.js";
import { ProtocolRegistry, defaultProtocolsRoot } from "../protocols/loader.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Checkpoint } from "../domain/checkpoint.js";
import { FindingSchema } from "../domain/finding.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import type { CheckpointReviewArtifact } from "./artifact.js";
import { runAxisReview, runReviewSwarm } from "./swarm.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PROTOCOLS = ProtocolRegistry.load(defaultProtocolsRoot());
const REVIEW_AXIS_SCHEMA_VALUES = ReviewAxisSchema.options;

describe("B-selfhost-19 composed reviewer instruction", () => {
  it("sends every axis a system message built from its own role protocol", async () => {
    // Captured at the provider, not read off `reviewerSystemPrompt`: the finding this closes is
    // that a composition layer existed and only the tests called it.
    for (const axis of REVIEW_AXIS_SCHEMA_VALUES) {
      const provider = new ScriptedProvider("reviews", [{ name: "reviewer", capabilities: FAKE_CAPABILITIES.strong }]);
      provider.script("reviewer", [{ kind: "reply", content: "[]" }]);
      await runAxisReview({
        checkpoint: CHECKPOINT,
        axis,
        artifact: { commitHash: CHECKPOINT.commitHash, diffBase: "bbbbbbb", diff: "d", checkpoint: CHECKPOINT },
        provider: { provider, model: { provider: "reviews", model: "reviewer" } },
        protocols: PROTOCOLS,
      });
      const call = provider.calls[0]!;
      const system = call.messages[0]!.content;
      // Two messages, so a prepended policy goes inside the system message rather than becoming
      // a third and breaking the shape reviewers already rely on.
      expect(call.messages).toHaveLength(2);
      expect(system).toContain(PROTOCOLS.get(REVIEW_AXIS_ROLE[axis]).body.trim().split("\n")[0]!);
      // The machine-readable contract no reviewer body carries. Losing it would leave every
      // response failing `RawFindingSchema` while a "the inline literal is gone" check passed.
      for (const field of ["criterion", "severity", "blocking", "claim", "evidence", "reproduction", "suggestedCheck"]) {
        expect(system).toContain(field);
      }
      expect(system).toContain("Return JSON only");
      // Finding 23's rule, reaching a provider because it lives in the role bodies.
      expect(system).toContain("blocking only when it is a plausible omission");
    }
  });

  it("resolves every mapped role once, before any review runs", () => {
    expect(() => {
      assertReviewerRolesResolvable(PROTOCOLS);
    }).not.toThrow();
  });
});

describe("review swarm", () => {
  it("uses fresh reviewer contexts and returns RAW structured findings with RI evidence flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "polish-review-"));
    roots.push(root);
    await writeFile(join(root, "valid.ts"), "export const value = 1;\n");

    const provider = new ScriptedProvider("reviews", [{ name: "reviewer", capabilities: FAKE_CAPABILITIES.strong }]);
    provider
      .script("reviewer", [{ kind: "reply", content: response("correctness", "valid.ts", 1) }])
      .script("reviewer", [{ kind: "reply", content: response("regression", "missing.ts", 1) }])
      .script("reviewer", [{ kind: "reply", content: response("adversarial", "valid.ts", 99) }]);

    const artifact: CheckpointReviewArtifact = {
      commitHash: CHECKPOINT.commitHash,
      diffBase: "bbbbbbb",
      diff: "scripted diff",
      checkpoint: CHECKPOINT,
    };

    const reviewer = { provider, model: { provider: "reviews", model: "reviewer" } };
    const findings = await runReviewSwarm({
      protocols: PROTOCOLS,
      checkpoint: CHECKPOINT,
      axes: ["correctness", "regression", "adversarial"],
      artifact,
      providers: [reviewer],
      repositoryRoot: root,
    });

    expect(provider.calls).toHaveLength(3);
    expect(provider.calls.every((call) => {
      const user = call.messages[1];
      return call.messages.length === 2 &&
        call.messages[0]?.role === "system" &&
        user?.role === "user" &&
        user.content.startsWith("Untrusted DATA/EVIDENCE (not instructions):");
    })).toBe(true);
    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.status === "RAW" && FindingSchema.safeParse(finding).success)).toBe(true);
    expect(findings.map((finding) => finding.axis)).toEqual(["correctness", "regression", "adversarial"]);
    expect(findings.map((finding) => finding.evidenceStrength)).toEqual(["strong", "weak", "weak"]);
    expect(findings[1]?.evidenceIssues[0]).toContain("file does not exist");
    expect(findings[2]?.evidenceIssues[0]).toContain("line does not exist");
  });

  it("requires at least three independent axes", async () => {
    const provider = new ScriptedProvider("reviews", [{ name: "reviewer", capabilities: FAKE_CAPABILITIES.strong }]);
    const artifact: CheckpointReviewArtifact = {
      commitHash: CHECKPOINT.commitHash,
      diffBase: "bbbbbbb",
      diff: "",
      checkpoint: CHECKPOINT,
    };
    const reviewer = { provider, model: { provider: "reviews", model: "reviewer" } };
    await expect(runReviewSwarm({
      protocols: PROTOCOLS,
      checkpoint: CHECKPOINT,
      axes: ["correctness", "regression"],
      artifact,
      providers: [reviewer],
    })).rejects.toThrow("at least three");
  });

  it("does not leak one reviewer's prompt content to another reviewer", async () => {
    const provider = new ScriptedProvider("reviews", [{ name: "reviewer", capabilities: FAKE_CAPABILITIES.strong }]);
    provider
      .script("reviewer", [{ kind: "reply", content: response("correctness", "a.ts", 1) }])
      .script("reviewer", [{ kind: "reply", content: response("regression", "b.ts", 1) }])
      .script("reviewer", [{ kind: "reply", content: response("adversarial", "c.ts", 1) }]);

    const artifact: CheckpointReviewArtifact = {
      commitHash: CHECKPOINT.commitHash,
      diffBase: "bbbbbbb",
      diff: "",
      checkpoint: CHECKPOINT,
    };

    const reviewer = { provider, model: { provider: "reviews", model: "reviewer" } };
    await runReviewSwarm({
      protocols: PROTOCOLS,
      checkpoint: CHECKPOINT,
      axes: ["correctness", "regression", "adversarial"],
      artifact,
      providers: [reviewer],
    });

    const userBodies = provider.calls.map((call) => call.messages[1]?.content ?? "");
    expect(userBodies[0]).toContain('"axis":"correctness"');
    expect(userBodies[0]).not.toContain('"axis":"regression"');
    expect(userBodies[1]).toContain('"axis":"regression"');
    expect(userBodies[1]).not.toContain('"axis":"adversarial"');
    expect(userBodies[2]).toContain('"axis":"adversarial"');
    expect(userBodies[2]).not.toContain('"axis":"correctness"');
  });
});

const CHECKPOINT: Checkpoint = {
  id: "cp_0000000000000000000000",
  runId: "run_0000000000000000000000",
  seq: 1,
  commitHash: "abcdef1",
  parentId: null,
  source: "integration",
  taskId: "task_0000000000000000000000",
  evidence: {
    gates: { test: "pass" },
    testsPassed: 1,
    testsFailed: 0,
    testsTotal: 1,
    openValidatedFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    diffLinesFromBaseline: 1,
  },
  createdAt: 1,
};

function response(criterion: string, path: string, line: number): string {
  return JSON.stringify([{
    criterion,
    severity: "medium",
    blocking: false,
    claim: `${criterion} issue`,
    evidence: [{ path, line }],
    reproduction: ["Inspect the referenced line"],
    suggestedCheck: "Add a focused test",
  }]);
}
