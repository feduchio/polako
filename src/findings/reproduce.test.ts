import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findingFingerprint, type Finding } from "../domain/finding.js";
import { MISSING_DEPENDENCIES_REASON } from "../shared/projectDependencies.js";
import { id } from "../shared/ids.js";
import { ProjectFindingEvidenceWorker } from "./reproduce.js";

const NOW = 1_700_000_000_000;
const HASH = "a".repeat(40);

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function testFinding(): Finding {
  const raw = {
    criterion: "auth.persistence",
    severity: "high" as const,
    blocking: true,
    claim: "logout leaves refresh token behind",
    evidence: [{ path: "src/auth/store.ts", line: 81 }],
    reproduction: ["pnpm test"],
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
  /**
   * The reproduction path and the check runner share one definition of "this command's result is
   * not evidence about the project" (MC1). Two definitions is how finding 54 survived: reproduction
   * refused to draw a conclusion from exactly this state while baselining drew one and stored it.
   *
   * The shape here is the one that separates the shared predicate from the old local copy it
   * replaced: `node_modules` **exists**, so a test keyed on its absence would run the command, and
   * a declared package is missing from it, so the shared test refuses.
   */
  it("refuses to reproduce where a declared package is missing from an existing node_modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-repro-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "x",
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^4", oxlint: "^1" },
    }));
    mkdirSync(join(dir, "node_modules", "oxlint"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "oxlint", "package.json"), '{"name":"oxlint"}');

    const worker = new ProjectFindingEvidenceWorker({
      projectPath: dir,
      persistOutput: () => { throw new Error("nothing may be executed here"); },
      now: () => NOW,
    });
    const attempt = await worker.reproduce(testFinding());
    expect(attempt).toMatchObject({
      method: "failing_test",
      verdict: "UNCERTAIN",
      rationale: MISSING_DEPENDENCIES_REASON,
    });
    expect(attempt.evidenceRefs).toEqual([]);
  });
});
