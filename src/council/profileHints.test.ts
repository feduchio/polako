import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { ProjectProfile } from "../project/profile.js";
import { executionEvidenceIsSufficient, intakeCouncilPayload } from "./profileHints.js";
import { createMission } from "../domain/mission.js";
import { buildBaselineEvidenceView } from "../project/baselineEvidence.js";

const PROFILE: ProjectProfile = {
  projectPath: "/tmp/polish-smoke",
  alias: null,
  packageManager: null,
  framework: "node-test",
  checks: [{ name: "test", kind: "test", command: ["npm", "run", "test"], mandatory: true }],
  manifestHashes: {},
  scriptsHash: "a".repeat(64),
  discoveredAt: 1,
};

const SHA = "2f978b24b034778d852a6cef080ff689153b8e2318635bab6e44b48eec228b62";

const BASELINE: BaselineSnapshot = {
  id: "base_0000000000000000000000",
  runId: "run_0000000000000000000000",
  commitHash: "abcdef1",
  checks: [
    {
      name: "test",
      kind: "test",
      status: "fail",
      exitCode: 1,
      durationMs: 1,
      summary: null,
      outputRef: { sha256: SHA, kind: "check_output", bytes: 2437, label: "ed6b93c3c42143721193b026ba0f7ef709929fd0:test" },
    },
  ],
  configHashes: {},
  scriptsHash: "a".repeat(64),
  toolchain: {},
  createdAt: 1,
};

describe("intake payload evidence boundary", () => {
  it("treats a ran baseline as sufficient execution evidence", () => {
    expect(executionEvidenceIsSufficient(PROFILE, BASELINE)).toBe(true);
  });

  it("puts compact baseline diagnostics in the payload instead of a hash-only snapshot", () => {
    const stdout = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/resume-dup-fetch/baseline-test.stdout.txt"),
      "utf8",
    );
    const forensic = {
      command: ["npm", "run", "test"],
      stdout,
      stderr: "",
      diagnostics: [
        "    not ok 2 - retries after transient failure and succeeds",
        "      error: 'duplicate in-flight request detected'",
        "# fail 1",
      ],
    };
    const evidence = buildBaselineEvidenceView(BASELINE, (sha) => (sha === SHA ? JSON.stringify(forensic) : null));
    const mission = createMission({
      id: "msn_0000000000000000000000",
      projectPath: "/tmp/polish-smoke",
      text: "Fix the RetryFetcher retry bug.",
      createdAt: 1,
    });
    const payload = intakeCouncilPayload(mission, PROFILE, BASELINE, evidence);
    const encoded = JSON.stringify(payload);
    expect(encoded).toContain("duplicate in-flight request detected");
    expect(encoded).toContain("informational");
    expect(encoded).toContain("authoritative");
    expect(encoded).toContain("baselineEvidence");
    expect(encoded).not.toContain("TAP version 13");
    expect(encoded).not.toContain("node:internal/test_runner");
    const execution = payload["execution"] as Record<string, unknown>;
    expect(execution["baseline"]).toEqual({
      id: BASELINE.id,
      runId: BASELINE.runId,
      commitHash: BASELINE.commitHash,
    });
    expect(Array.isArray(execution["baselineEvidence"])).toBe(true);
  });
});
