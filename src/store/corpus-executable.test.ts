/**
 * P1.8 — the Mission Acceptance Corpus becomes executable.
 *
 * `docs/PLAN.md` §7 records the corpus invariant as violated in production: entries are metadata
 * that is never injected or executed. Two things made that true. `CorpusEntry` carried
 * `artifactHashes` and no path, so it could not be materialized; and nothing in the tree emitted
 * `acceptance.recorded`, so `acceptance_artifacts` was empty in every run that has ever executed
 * (finding 53). These checks cover the repair at the store boundary; the gate-level ones live
 * beside the candidate drivers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CORPUS_EXECUTABLE_STATUS,
  type AcceptanceArtifact,
  type CorpusEntry,
} from "../domain/acceptance.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import { createMission } from "../domain/mission.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "./index.js";
import { MissionAcceptanceService, acceptanceArtifactsForGate } from "./missionAcceptance.js";

const NOW = 1_700_000_000_000;

describe("executable mission acceptance corpus", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;
  let corpus: MissionAcceptanceService;
  let runId: string;
  let missionId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-corpus-exec-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(NOW);
    corpus = new MissionAcceptanceService(store, clock);
    const mission = createMission({ id: id("msn", NOW), projectPath: "/repo", text: "fix it", createdAt: NOW });
    missionId = mission.id;
    runId = id("run", NOW);
    store.events.append([
      {
        id: id("evt", NOW),
        runId,
        ts: NOW,
        type: "mission.recorded",
        payload: { mission },
        causedBy: [],
        actor: SYSTEM_ACTOR,
        artifacts: [],
      },
      {
        id: id("evt", NOW),
        runId,
        ts: NOW,
        type: "run.created",
        payload: {
          run: {
            id: runId,
            missionId,
            projectPath: "/repo",
            runBranch: "polish/run",
            phase: "CREATED",
            control: "RUNNING",
            currentCheckpointHash: null,
            baselineId: null,
            interpretationId: null,
            createdAt: NOW,
            updatedAt: NOW,
            terminalReason: null,
          },
        },
        causedBy: [],
        actor: SYSTEM_ACTOR,
        artifacts: [],
      },
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (): CorpusEntry => corpus.record({
    missionId,
    sourceRunId: runId,
    requirementRef: "R1",
    kind: "regression_test",
    summary: "Validated finding: the guard admits an equal value",
    evidenceRefs: [],
    artifactHashes: ["a".repeat(64)],
    metadata: {
      findingId: id("find", NOW),
      executableStatus: CORPUS_EXECUTABLE_STATUS.pendingIntegration,
    },
  });

  const artifactFor = (relativePath: string, content: string): AcceptanceArtifact => ({
    id: id("acc", NOW),
    runId,
    taskId: null,
    kind: "regression_test",
    relativePath,
    sha256: store.acceptance.putContent(content, `corpus:${relativePath}`),
    evidenceFor: null,
    createdAt: NOW,
  });

  const resolve = (artifactId: string): AcceptanceArtifact | undefined =>
    store.repos.acceptance.get(artifactId) ?? undefined;

  it("admits the artifact and the amended entry in one append", () => {
    const original = entry();
    expect(original.executable).toBeNull();
    const artifact = artifactFor("tests/retry.test.mjs", "test('retries', () => {});\n");
    const amended = corpus.admitExecutable({ entryId: original.id, artifact });

    expect(amended.executable).toEqual({
      artifactId: artifact.id,
      relativePath: "tests/retry.test.mjs",
      sha256: artifact.sha256,
    });
    // The projection is an upsert on id, so the entry is amended rather than duplicated.
    expect(store.repos.acceptanceCorpus.forMission(missionId).entries).toHaveLength(1);
    // finding 53: this is the first `acceptance.recorded` the system produces, and the row it
    // projects is what every downstream protected-path stage reads.
    expect(store.repos.acceptance.get(artifact.id)).toEqual(artifact);
    expect(store.events.list(runId, { types: ["acceptance.recorded"] })).toHaveLength(1);
  });

  /**
   * Atomicity is the use of one transaction, and `EventLog.append` is where the transaction is.
   * Two appends would leave the artifact behind when the second failed, and no assertion on the
   * end state can see that when the failure is arranged before either of them.
   */
  it("appends the artifact and the amendment in a single transaction", () => {
    const original = entry();
    const appends: number[] = [];
    const real = store.events.append.bind(store.events);
    store.events.append = (events) => { appends.push(events.length); return real(events); };
    try {
      corpus.admitExecutable({ entryId: original.id, artifact: artifactFor("tests/a.test.mjs", "x") });
    } finally {
      store.events.append = real;
    }
    expect(appends).toEqual([2]);
  });

  it("leaves neither the artifact nor the amendment when admission fails", () => {
    const original = entry();
    const artifact = artifactFor("tests/retry.test.mjs", "x");
    expect(() => corpus.admitExecutable({
      entryId: original.id,
      // `runId` is not an id, so the artifact fails schema parse before anything is appended.
      artifact: { ...artifact, runId: "not-an-id" },
    })).toThrow();
    expect(store.repos.acceptance.get(artifact.id)).toBeNull();
    expect(store.repos.acceptanceCorpus.get(original.id)?.executable).toBeNull();
    expect(store.events.list(runId, { types: ["acceptance.recorded"] })).toHaveLength(0);
  });

  it("refuses to admit against an entry that does not exist", () => {
    expect(() => corpus.admitExecutable({
      entryId: id("corp", NOW),
      artifact: artifactFor("tests/a.test.mjs", "x"),
    })).toThrow(/does not exist/);
  });

  describe("acceptanceArtifactsForGate", () => {
    it("unions the task's artifacts with the corpus's admitted executables", () => {
      const original = entry();
      const artifact = artifactFor("tests/retry.test.mjs", "x");
      corpus.admitExecutable({ entryId: original.id, artifact });
      const own = artifactFor("acceptance/own.txt", "y");

      const union = acceptanceArtifactsForGate([own], corpus.get(missionId), resolve);
      expect(union.map((a) => a.relativePath).sort())
        .toEqual(["acceptance/own.txt", "tests/retry.test.mjs"]);
    });

    it("fails closed on a legacy entry that carries no decision", () => {
      const legacy = entry();
      const stored = store.repos.acceptanceCorpus.get(legacy.id)!;
      corpus.record({
        ...stored,
        metadata: { findingId: stored.metadata["findingId"] },
      });
      expect(() => acceptanceArtifactsForGate([], corpus.get(missionId), resolve))
        .toThrow(new RegExp(`unmappable_legacy_corpus_entry: ${legacy.id}`));
    });

    it("permits every explicitly pending entry until its fixing task integrates", () => {
      const pending = entry();
      entry();
      expect(acceptanceArtifactsForGate([], corpus.get(missionId), resolve)).toEqual([]);
      expect(store.repos.acceptanceCorpus.get(pending.id)?.metadata["executableStatus"])
        .toBe(CORPUS_EXECUTABLE_STATUS.pendingIntegration);
    });

    it("does not classify a newly recorded runtime-only entry as legacy", () => {
      corpus.recordRuntimeScenario({
        missionId,
        sourceRunId: runId,
        requirementRef: "runtime.check",
        scenarioId: "check",
        summary: "runtime evidence",
      });
      expect(acceptanceArtifactsForGate([], corpus.get(missionId), resolve)).toEqual([]);
    });

    it("fails closed when an admitted artifact is not in the store", () => {
      const original = entry();
      const artifact = artifactFor("tests/retry.test.mjs", "x");
      corpus.admitExecutable({ entryId: original.id, artifact });
      const missing = (): AcceptanceArtifact | undefined => undefined;
      expect(() => acceptanceArtifactsForGate([], corpus.get(missionId), missing))
        .toThrow(/unmappable_legacy_corpus_entry/);
    });

    /**
     * The decision and the legacy shape are both `executable: null`. Only the recorded status
     * separates them, and a skip that did not distinguish them is how the corpus stopped being
     * cumulative without anything failing.
     */
    it("skips an entry whose decision was recorded, and only that one", () => {
      const decided = entry();
      corpus.recordExecutableAbsent({ entryId: decided.id, reason: "no_test_file_in_diff" });
      expect(acceptanceArtifactsForGate([], corpus.get(missionId), resolve)).toEqual([]);

      const legacy = entry();
      corpus.record({
        ...legacy,
        metadata: { findingId: legacy.metadata["findingId"] },
      });
      expect(() => acceptanceArtifactsForGate([], corpus.get(missionId), resolve))
        .toThrow(/unmappable_legacy_corpus_entry/);
    });

    it("is stable and does not duplicate an artifact present on both sides", () => {
      const original = entry();
      const artifact = artifactFor("tests/retry.test.mjs", "x");
      corpus.admitExecutable({ entryId: original.id, artifact });
      const union = acceptanceArtifactsForGate([artifact], corpus.get(missionId), resolve);
      expect(union).toHaveLength(1);
    });
  });
});
