import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findingFingerprint, type Finding } from "../domain/finding.js";
import { id } from "../shared/ids.js";
import { ProjectFindingEvidenceWorker } from "./reproduce.js";

const NOW = 1_700_000_000_000;
const HASH = "a".repeat(40);

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function testFinding(reproduction: string[]): Finding {
  const raw = {
    criterion: "auth.persistence",
    severity: "high" as const,
    blocking: true,
    claim: "logout leaves refresh token behind; the regression test misses it",
    evidence: [{ path: "src/auth/store.ts", line: 81 }],
    reproduction,
    suggestedCheck: "pnpm test",
  };
  return {
    id: id("find", NOW),
    runId: id("run", NOW),
    checkpointHash: HASH,
    axis: "correctness",
    reportedBy: { kind: "reviewer" },
    status: "UNCERTAIN",
    duplicateOf: null,
    fingerprint: findingFingerprint(raw),
    investigationRounds: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...raw,
  };
}

describe("ProjectFindingEvidenceWorker", () => {
  it("never executes a reviewer's reproduction text, even one naming a package manager", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-repro-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
    const marker = join(dir, "marker");
    const code = `require("fs").writeFileSync(${JSON.stringify(marker)},"x");process.exit(1)`;

    const worker = new ProjectFindingEvidenceWorker({
      projectPath: dir,
      persistOutput: () => { throw new Error("nothing may be executed here"); },
      now: () => NOW,
    });
    const attempt = await worker.reproduce(testFinding([`npm exec --yes -- node -e ${code}`, "pnpm test"]));

    expect(existsSync(marker)).toBe(false);
    expect(attempt).toMatchObject({ method: "none", verdict: "UNCERTAIN" });
    expect(attempt.rationale).toContain("nothing was executed");
    expect(attempt.evidenceRefs).toEqual([]);
  });
});
