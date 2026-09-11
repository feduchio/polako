import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isStaleRuntimeEvidence, runtimeAllowsDone, runtimeCorpusAllowsDone, type RuntimeEvidence } from "../domain/acceptance.js";
import { defaultConfig } from "../domain/config.js";
import type { Run } from "../domain/run.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { MissionAcceptanceService, openStore } from "../store/index.js";
import { discoverProjectRuntime } from "./projectDiscovery.js";
import { discoverRuntimeValidator } from "./discovery.js";
import { FixtureRuntimeValidator } from "./fixtureRunner.js";
import {
  resolveProductionRuntimeTemplates,
  rerunRuntimeScenarios,
  templatesFromCorpus,
  templatesFromDiscoveredPayload,
} from "./corpus.js";
import { RuntimeUnavailableError, type DiscoveredRuntimeTemplate, type RuntimeScenario } from "./types.js";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const NOW = 1_700_000_000_000;

function run(runId: string, missionId: string): Run {
  return {
    id: runId,
    missionId,
    projectPath: "/tmp/p",
    runBranch: `polish/${runId}`,
    phase: "CREATED",
    control: "RUNNING",
    currentCheckpointHash: HASH_A,
    baselineId: null,
    interpretationId: null,
    createdAt: NOW,
    updatedAt: NOW,
    terminalReason: null,
  };
}

describe("runtime validation v1", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function fixtureProject(script: string, body: string): string {
    const root = mkdtempSync(join(tmpdir(), "polish-runtime-"));
    cleanup.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    mkdirSync(join(root, "runtime"));
    writeFileSync(join(root, "runtime", script), body, { mode: 0o644 });
    return root;
  }

  it("defaults runtime validation to auto and serial local.runtime lane", () => {
    const cfg = defaultConfig();
    expect(cfg.runtimeValidation.mode).toBe("auto");
    expect(cfg.runtimeValidation.level).toBe("smoke");
    expect(cfg.lanes["local.runtime"]).toBe(1);
  });

  it("discovers a safe local node scenario from runtime/", () => {
    const root = fixtureProject("check.mjs", "process.exit(0);\n");
    const discovery = discoverProjectRuntime(root);
    expect(discovery.capability).toBe("AVAILABLE_SAFE");
    expect(discovery.templates.map((t) => t.relativeScript)).toEqual(["runtime/check.mjs"]);
  });

  it("classifies projects without runtime/ as NOT_APPLICABLE", () => {
    const root = mkdtempSync(join(tmpdir(), "polish-runtime-none-"));
    cleanup.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "none", private: true }));
    expect(discoverProjectRuntime(root).capability).toBe("NOT_APPLICABLE");
  });

  it("auto + safe fixture script records checkpoint-bound passing evidence", async () => {
    const root = fixtureProject("check.mjs", "console.log('ok'); process.exit(0);\n");
    const scenario: RuntimeScenario = {
      id: "check",
      runId: id("run", NOW),
      checkpointHash: HASH_A,
      kind: "node_script",
      fixtureRoot: root,
      script: "runtime/check.mjs",
    };
    const selection = await discoverRuntimeValidator("auto", scenario, [new FixtureRuntimeValidator({ now: () => NOW })]);
    expect(selection.validator).not.toBeNull();
    const evidence = await selection.validator!.validate(scenario);
    expect(evidence.status).toBe("passed");
    expect(evidence.checkpointHash).toBe(HASH_A);
    expect(evidence.validator).toBe("fixture-runtime");
    expect(isStaleRuntimeEvidence(evidence, HASH_A)).toBe(false);
    expect(runtimeAllowsDone("auto", evidence, HASH_A)).toBe(true);
  });

  it("auto + no safe path skips without failing", async () => {
    const scenario: RuntimeScenario = {
      id: "missing",
      runId: id("run", NOW),
      checkpointHash: HASH_A,
      kind: "node_script",
      fixtureRoot: "/no/such/project",
      script: "runtime/check.mjs",
    };
    const selection = await discoverRuntimeValidator("auto", scenario, [new FixtureRuntimeValidator({ now: () => NOW })]);
    expect(selection.validator).toBeNull();
    expect(runtimeAllowsDone("auto", null, HASH_A)).toBe(true);
  });

  it("required + no validator throws and cannot DONE", async () => {
    const scenario: RuntimeScenario = {
      id: "missing",
      runId: id("run", NOW),
      checkpointHash: HASH_A,
      kind: "node_script",
      fixtureRoot: "/no/such/project",
      script: "runtime/check.mjs",
    };
    await expect(discoverRuntimeValidator("required", scenario, [new FixtureRuntimeValidator()])).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );
    expect(runtimeAllowsDone("required", null, HASH_A)).toBe(false);
  });

  it("required + baseline evidence is stale after a new checkpoint", async () => {
    const root = fixtureProject("check.mjs", "process.exit(0);\n");
    const scenario: RuntimeScenario = {
      id: "check",
      runId: id("run", NOW),
      checkpointHash: HASH_A,
      kind: "node_script",
      fixtureRoot: root,
      script: "runtime/check.mjs",
    };
    const evidence = await new FixtureRuntimeValidator({ now: () => NOW }).validate(scenario);
    expect(isStaleRuntimeEvidence(evidence, HASH_B)).toBe(true);
    expect(runtimeAllowsDone("required", evidence, HASH_B)).toBe(false);
    expect(runtimeAllowsDone("required", evidence, HASH_A)).toBe(true);
  });

  it("required + failed final scenario cannot DONE even if tests are otherwise green", async () => {
    const root = fixtureProject("check.mjs", "process.exit(2);\n");
    const scenario: RuntimeScenario = {
      id: "check",
      runId: id("run", NOW),
      checkpointHash: HASH_B,
      kind: "node_script",
      fixtureRoot: root,
      script: "runtime/check.mjs",
    };
    const evidence = await new FixtureRuntimeValidator({ now: () => NOW }).validate(scenario);
    expect(evidence.status).toBe("failed");
    expect(runtimeAllowsDone("required", evidence, HASH_B)).toBe(false);
  });

  it("auto uses only AVAILABLE_SAFE validators and ignores unsafe hosts", async () => {
    const scenario: RuntimeScenario = {
      id: "http",
      runId: id("run", NOW),
      checkpointHash: HASH_A,
      kind: "http_smoke",
      url: "https://example.com/health",
    };
    const selection = await discoverRuntimeValidator("auto", scenario, [new FixtureRuntimeValidator({ now: () => NOW })]);
    expect(selection.validator).toBeNull();
    expect(selection.capability).toBe("AVAILABLE_UNSAFE");
  });

  it("corpus retains a validated scenario and rejects stale evidence for a later checkpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-runtime-store-"));
    cleanup.push(dir);
    const store = openStore({ home: dir });
    try {
      const missionId = id("msn", NOW);
      const runId = id("run", NOW);
      store.events.append([{
        id: id("evt", NOW),
        runId,
        ts: NOW,
        type: "run.created",
        payload: { run: run(runId, missionId) },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      }]);
      const corpus = new MissionAcceptanceService(store, new FakeClock(NOW));
      const scenario = corpus.recordRuntimeScenario({
        missionId,
        sourceRunId: runId,
        requirementRef: "runtime.required_scenario",
        scenarioId: "check",
        summary: "fixture smoke",
        metadata: { script: "runtime/check.mjs" },
      });
      expect(scenario.kind).toBe("runtime_scenario");
      const evidence: RuntimeEvidence = {
        id: id("rte", NOW),
        runId,
        scenarioId: "check",
        validator: "fixture-runtime",
        kind: "node_script",
        status: "passed",
        summary: "ok",
        observations: {},
        checkpointHash: HASH_A,
        sideEffects: { policy: "safe", destructiveExternalEffectsAllowed: false },
        artifactHashes: [],
        startedAt: NOW,
        finishedAt: NOW,
      };
      const recorded = corpus.recordRuntimeEvidence({
        missionId,
        requirementRef: "runtime.required_scenario",
        evidence,
        expectedCheckpointHash: HASH_A,
      });
      expect(recorded.runtimeEvidence?.checkpointHash).toBe(HASH_A);
      expect(corpus.get(missionId).entries).toHaveLength(2);
      expect(() =>
        corpus.recordRuntimeEvidence({
          missionId,
          requirementRef: "runtime.required_scenario",
          evidence,
          expectedCheckpointHash: HASH_B,
        }),
      ).toThrow(/does not match the expected checkpoint/);

      const templates = templatesFromCorpus(corpus.get(missionId));
      expect(templates).toEqual([
        { id: "check", kind: "node_script", relativeScript: "runtime/check.mjs", sideEffectPolicy: "safe" },
      ]);
    } finally {
      store.close();
    }
  });

  it("re-runs a retained corpus scenario against a later checkpoint", async () => {
    const root = fixtureProject("check.mjs", "process.exit(0);\n");
    const dir = mkdtempSync(join(tmpdir(), "polish-runtime-rerun-"));
    cleanup.push(dir);
    const store = openStore({ home: dir });
    try {
      const missionId = id("msn", NOW);
      const runId = id("run", NOW);
      store.events.append([{
        id: id("evt", NOW),
        runId,
        ts: NOW,
        type: "run.created",
        payload: { run: run(runId, missionId) },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      }]);
      const corpus = new MissionAcceptanceService(store, new FakeClock(NOW));
      corpus.recordRuntimeScenario({
        missionId,
        sourceRunId: runId,
        requirementRef: "runtime.required_scenario",
        scenarioId: "check",
        summary: "fixture smoke",
        metadata: { script: "runtime/check.mjs" },
      });
      const validator = new FixtureRuntimeValidator({ now: () => NOW });
      const first = await rerunRuntimeScenarios({
        templates: templatesFromCorpus(corpus.get(missionId)),
        projectPath: root,
        runId,
        checkpointHash: HASH_A,
        validator,
      });
      expect(first).toHaveLength(1);
      expect(first[0]?.status).toBe("passed");
      expect(first[0]?.checkpointHash).toBe(HASH_A);
      corpus.recordRuntimeEvidence({
        missionId,
        requirementRef: "runtime.required_scenario",
        evidence: first[0]!,
        expectedCheckpointHash: HASH_A,
      });

      const second = await rerunRuntimeScenarios({
        templates: templatesFromCorpus(corpus.get(missionId)),
        projectPath: root,
        runId,
        checkpointHash: HASH_B,
        validator,
      });
      expect(second[0]?.status).toBe("passed");
      expect(second[0]?.checkpointHash).toBe(HASH_B);
      expect(isStaleRuntimeEvidence(first[0]!, HASH_B)).toBe(true);
      expect(runtimeAllowsDone("required", first[0]!, HASH_B)).toBe(false);
      expect(runtimeAllowsDone("required", second[0]!, HASH_B)).toBe(true);
      expect(runtimeCorpusAllowsDone("required", second, HASH_B, ["check"])).toBe(true);
      expect(runtimeCorpusAllowsDone("required", first, HASH_B, ["check"])).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("production runtime template precedence", () => {
  function template(id: string): DiscoveredRuntimeTemplate {
    return { id, kind: "node_script", relativeScript: `runtime/${id}.mjs`, sideEffectPolicy: "safe" };
  }

  it("keeps only well-formed entries from a project.discovered payload", () => {
    const parsed = templatesFromDiscoveredPayload({
      runtimeTemplates: [
        { id: "ok", kind: "node_script", relativeScript: "runtime/ok.mjs", sideEffectPolicy: "safe" },
        { id: "wrong-kind", kind: "http_smoke", relativeScript: "runtime/x.mjs", sideEffectPolicy: "safe" },
        { id: "no-script", kind: "node_script", sideEffectPolicy: "safe" },
        null,
      ],
    });
    expect(parsed.map((entry) => entry.id)).toEqual(["ok"]);
    expect(templatesFromDiscoveredPayload(null)).toEqual([]);
    expect(templatesFromDiscoveredPayload({ runtimeTemplates: "nope" })).toEqual([]);
  });

  it("prefers checkout discovery over run-start discovery", () => {
    const resolved = resolveProductionRuntimeTemplates({
      checkoutTemplates: [template("checkout")],
      discoveredTemplates: [template("discovered")],
      corpusTemplates: [template("corpus")],
    });
    expect(resolved.map((entry) => entry.id)).toEqual(["checkout", "corpus"]);
  });

  it("falls back to run-start discovery when the checkout has no runtime scenarios", () => {
    const resolved = resolveProductionRuntimeTemplates({
      checkoutTemplates: [],
      discoveredTemplates: [template("discovered")],
      corpusTemplates: [template("corpus")],
    });
    expect(resolved.map((entry) => entry.id)).toEqual(["discovered", "corpus"]);
  });

  it("uses corpus alone only when neither discovery source has templates", () => {
    expect(
      resolveProductionRuntimeTemplates({
        checkoutTemplates: [],
        discoveredTemplates: [],
        corpusTemplates: [template("corpus")],
      }).map((entry) => entry.id),
    ).toEqual(["corpus"]);
    expect(
      resolveProductionRuntimeTemplates({ checkoutTemplates: [], discoveredTemplates: [] }),
    ).toEqual([]);
  });

  it("does not duplicate a corpus template that repeats a discovered script", () => {
    const resolved = resolveProductionRuntimeTemplates({
      checkoutTemplates: [template("check")],
      discoveredTemplates: [],
      corpusTemplates: [{ ...template("check"), id: "corpus-alias" }],
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.id).toBe("check");
  });
});
