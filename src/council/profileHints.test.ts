import { describe, expect, it } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { ProjectProfile } from "../project/profile.js";
import {
  executionEvidenceIsSufficient,
  isInformationalProfileHintText,
  neutralizeInformationalAmbiguities,
  neutralizeInformationalProfileVotes,
} from "./profileHints.js";

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
      outputRef: null,
    },
  ],
  configHashes: {},
  scriptsHash: "a".repeat(64),
  toolchain: {},
  createdAt: 1,
};

describe("profile hint vs blocking execution uncertainty", () => {
  it("treats captured smoke strings as informational hints", () => {
    expect(
      isInformationalProfileHintText(
        "Discovery reports framework='unknown' and packageManager=null — need to confirm the project structure and test runner.",
      ),
    ).toBe(true);
    expect(executionEvidenceIsSufficient(PROFILE, BASELINE)).toBe(true);
  });

  it("does not treat a lockfile or project-structure concern as a hint by itself", () => {
    expect(isInformationalProfileHintText("No lockfile for reproducible deploys")).toBe(false);
    expect(isInformationalProfileHintText("Need to confirm project structure for auth module placement")).toBe(false);
    const opinions = neutralizeInformationalProfileVotes(
      [{ role: "scope_guardian", decision: "needs_human", rationale: "blocked", concerns: ["No lockfile for reproducible deploys"] }],
      PROFILE,
      BASELINE,
    );
    expect(opinions[0]?.decision).toBe("needs_human");
  });

  it("keeps genuine API-compatibility NEEDS_HUMAN and mixed API questions blocking", () => {
    const [api] = neutralizeInformationalAmbiguities(
      [{ question: "Which API should remain compatible?", options: ["Public API", "Internal API"], blocking: true }],
      PROFILE,
      BASELINE,
    );
    expect(api?.blocking).toBe(true);
    const [mixed] = neutralizeInformationalAmbiguities(
      [
        {
          question: "Which API version is compatible and what is the project structure?",
          options: ["v1", "v2"],
          blocking: true,
        },
      ],
      PROFILE,
      BASELINE,
    );
    expect(mixed?.blocking).toBe(true);
  });

  it("clears only hint-only votes when baseline checks already ran", () => {
    const opinions = neutralizeInformationalProfileVotes(
      [
        {
          role: "scope_guardian",
          decision: "needs_human",
          rationale: "Discovery reports framework='unknown' and packageManager=null",
          concerns: ["packageManager=null", "framework='unknown'"],
        },
      ],
      PROFILE,
      BASELINE,
    );
    expect(opinions[0]?.decision).toBe("approve");
  });
});
