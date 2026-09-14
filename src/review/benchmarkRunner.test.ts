import { describe, expect, it } from "vitest";
import type {
  CompletionRequest,
  CompletionResponse,
  ModelInfo,
  ProviderAdapter,
} from "../broker/types.js";
import { DISABLED_REASONING, REVIEW_FINDINGS_RESPONSE_SCHEMA } from "../broker/responseSchemas.js";
import { ReviewStrategySchema } from "../domain/config.js";
import { ProtocolRegistry, defaultProtocolsRoot } from "../protocols/loader.js";
import { sha256Hex } from "../shared/hash.js";
import { canonicalJsonLine, scoreQuality } from "./benchmark.js";
import { REVIEWER_BENCHMARK_PAIRS } from "./benchmarkCorpus.js";
import { reviewerSystemPrompt } from "./reviewerProtocol.js";
import {
  buildBenchmarkSchedule,
  renderReviewerBenchmark,
  renderReviewerBenchmarkComparison,
  runReviewerBenchmark,
  rescoreReviewerBenchmark,
  selectBenchmarkReviewers,
  selectOperationalBenchmarkReviewers,
  type BenchmarkReviewer,
} from "./benchmarkRunner.js";

const PROTOCOLS = ProtocolRegistry.load(defaultProtocolsRoot());

describe("review benchmark runner", () => {
  it("runs 288 cells, one per axis, each through its own production prompt and parser", async () => {
    const nex = provider("nex", "nex-agi/nex-n2.5-pro:free", () => reply('{"findings":[]}'));
    const nvidia = provider("nvidia", "nvidia/nemotron:free", () => reply('{"findings":[]}'));
    const report = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 7,
    });

    expect(report.requested).toBe(288);
    expect(report.cells).toHaveLength(288);
    expect(nex.calls).toHaveLength(144);
    expect(nvidia.calls).toHaveLength(144);
    expect(report.partial).toBe(false);
    expect(report.cells.every((cell) => cell.outcome === "completed_empty")).toBe(true);

    // AC2: every axis scheduled equally, and once per (pair, label, reviewer, repetition).
    const perAxis = new Map<string, number>();
    for (const cell of report.cells) perAxis.set(cell.oracle.axis, (perAxis.get(cell.oracle.axis) ?? 0) + 1);
    expect([...perAxis.entries()].sort()).toEqual([["adversarial", 96], ["correctness", 96], ["regression", 96]]);

    // AC1: the axis is part of cell identity, so no two cells collide.
    expect(new Set(report.cells.map((cell) => cell.oracle.cellId)).size).toBe(288);

    // AC2's real claim: every (pair, label, reviewer, repetition) tuple carries all three axes.
    // Equal per-axis totals do not imply that — a schedule giving one reviewer two `correctness`
    // and the other two `adversarial` balances out and is still wrong.
    const byTuple = new Map<string, string[]>();
    for (const cell of report.cells) {
      const key = `${cell.oracle.pairId}|${cell.oracle.label}|${modelKeyOf(cell)}|${String(cell.oracle.repetition)}`;
      byTuple.set(key, [...(byTuple.get(key) ?? []), cell.oracle.axis]);
    }
    expect(byTuple.size).toBe(96);
    for (const [, axes] of byTuple) {
      expect([...axes].sort()).toEqual(["adversarial", "correctness", "regression"]);
    }

    // AC3: each cell is reviewed on the axis it was scheduled for, not `correctness`.
    for (const cell of report.cells) {
      expect(cell.request?.metadata.purpose).toBe(`review_${cell.oracle.axis}`);
      expect(cell.request?.messages[0]?.content).toBe(reviewerSystemPrompt(PROTOCOLS, cell.oracle.axis));
    }
    expect(report.transportMode).toBe("strict_schema");
    expect(report.cells[0]?.request?.responseSchema).toEqual(REVIEW_FINDINGS_RESPONSE_SCHEMA);
    expect(report.cells[0]?.request?.reasoning).toEqual(DISABLED_REASONING);
    expect(report.cells.every((cell) => cell.request?.responseSchema?.strict === true)).toBe(true);
    expect(report.packetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.oracleSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("retains a contemporaneous legacy json_object control arm", async () => {
    const nex = provider("nex", "nex-agi/a:free", () => reply('{"findings":[]}'));
    const nvidia = provider("nvidia", "nvidia/a:free", () => reply('{"findings":[]}'));
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const report = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 43,
      pairs: [pair],
      axes: ["correctness"],
      transportMode: "legacy_json_object",
    });
    expect(report.transportMode).toBe("legacy_json_object");
    expect(report.cells.every((cell) =>
      cell.request?.responseFormat === "json" &&
      cell.request.responseSchema === undefined &&
      cell.request.reasoning === undefined)).toBe(true);
  });

  it("selects an operational ensemble from two distinct free probed-strict families", () => {
    const free = {
      supportsStrictReviewSchema: true,
      inputCostPerM: 0,
      outputCostPerM: 0,
    };
    const p = provider("p", "ignored", () => reply('{"findings":[]}'));
    const selected = selectOperationalBenchmarkReviewers([{
      provider: p,
      models: [
        info("p", "z", "family-a", free),
        info("p", "a", "family-a", free),
        info("p", "b", "family-b", free),
        info("p", "unprobed", "family-0", { ...free, supportsStrictReviewSchema: false }),
      ],
    }]);
    expect(selected.map((item) => item.model.model)).toEqual(["a", "b"]);
    expect(selected.map((item) => item.family)).toEqual(["family-a", "family-b"]);
  });

  it("renders transport denominators beside quality for multi-report comparison", async () => {
    const nex = provider("nex", "nex-agi/a:free", () => reply('{"findings":[]}'));
    const nvidia = provider("nvidia", "nvidia/a:free", () => reply('{"findings":[]}'));
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const reviewers = [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")] as const;
    const legacy = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers,
      seed: 43,
      pairs: [pair],
      axes: ["correctness"],
      transportMode: "legacy_json_object",
      configuration: "original",
    });
    const strict = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers,
      seed: 43,
      pairs: [pair],
      axes: ["correctness"],
      transportMode: "strict_schema",
      configuration: "operational_strict",
    });
    const rendered = renderReviewerBenchmarkComparison([legacy, strict]);
    expect(rendered).toContain("configuration=original transport=legacy_json_object");
    expect(rendered).toContain("configuration=operational_strict transport=strict_schema");
    expect(rendered).toContain("completion=12/12 schema=0 transport_failures=0");
    expect(rendered).toContain("primary=");
    expect(rendered).toContain("false_positive=");
  });

  it("keeps pair metadata blind outside diff and cell ids off the wire", async () => {
    const nex = provider("nex", "nex-agi/a:free", () => reply('{"findings":[]}'));
    const nvidia = provider("nvidia", "nvidia/a:free", () => reply('{"findings":[]}'));
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const report = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 1,
      pairs: [pair],
      axes: ["correctness"],
    });
    const clean = report.cells.find((cell) => cell.oracle.label === "clean");
    const mutant = report.cells.find((cell) =>
      cell.oracle.label === "mutant" &&
      cell.model.provider === clean?.model.provider &&
      cell.oracle.repetition === clean.oracle.repetition);
    if (clean?.request === null || clean?.request === undefined || mutant?.request === null || mutant?.request === undefined) {
      throw new Error("missing captured requests");
    }
    expect(clean.request.messages[0]?.content).toBe(mutant.request.messages[0]?.content);
    const cleanPack = pack(clean.request);
    const mutantPack = pack(mutant.request);
    const cleanDiff = cleanPack["diff"];
    const mutantDiff = mutantPack["diff"];
    delete cleanPack["diff"];
    delete mutantPack["diff"];
    expect(cleanPack).toEqual(mutantPack);
    expect(cleanDiff).not.toBe(mutantDiff);
    expect(JSON.stringify(cleanPack)).not.toMatch(/\b(clean|mutant|defect|injected)\b/i);
    for (const family of REVIEWER_BENCHMARK_PAIRS.map((item) => item.family)) {
      expect(JSON.stringify(cleanPack)).not.toContain(family);
    }
    for (const cell of [clean, mutant]) {
      const request = cell.request;
      if (request === null) throw new Error("missing captured request");
      expect(JSON.stringify(request.messages)).not.toContain(cell.oracle.cellId);
    }
  });

  it("captures usage and raw content before a schema failure", async () => {
    const broken = provider("broken", "nex-agi/a:free", () => reply('{"summary":"not findings"}', 11, 29));
    const empty = provider("empty", "nvidia/a:free", () => reply('{"findings":[]}'));
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const report = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(broken, "nex-agi"), reviewer(empty, "nvidia")],
      seed: 3,
      pairs: [pair],
      axes: ["correctness"],
    });
    const failures = report.cells.filter((cell) => cell.family === "nex-agi");
    expect(failures).toHaveLength(6);
    expect(failures.every((cell) =>
      cell.outcome === "schema_failure" &&
      cell.rawContent === '{"summary":"not findings"}' &&
      cell.usage?.outputTokens === 29)).toBe(true);
    expect(report.byModel["broken:nex-agi/a:free"]?.schemaFailures).toBe(6);
    expect(report.byModel["broken:nex-agi/a:free"]?.outputTokens).toBe(174);
  });

  it("never requeues and applies the live abort only at cell 20", async () => {
    const fail = (): Promise<CompletionResponse> => Promise.reject(new Error("transport down"));
    const nex = provider("nex", "nex-agi/a:free", fail);
    const nvidia = provider("nvidia", "nvidia/a:free", fail);
    const reviewers = [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")] as const;

    const full = await runReviewerBenchmark({ protocols: PROTOCOLS, reviewers, seed: 5 });
    expect(full.cells).toHaveLength(288);
    expect(full.team.transportFailures).toBe(288);
    expect(full.team.completed).toBe(0);
    const summary = renderReviewerBenchmark(full);
    expect(summary).toContain("0/288 completed cells");
    expect(summary).toContain("undefined primary recall");
    expect(summary).toContain("undefined strict-id recall");
    expect(summary).toContain("undefined false positives");
    expect(summary).toContain("undefined pair discrimination");
    expect(summary).toContain("0 input + 0 output tokens");
    expect(summary).toContain("undefined output tokens/hit");
    expect(summary).toContain("schema=0/288 (0.0%)");
    expect(summary).toContain("transport=288/288 (100.0%)");
    expect(summary).toContain("team (all axes): undefined primary recall, undefined strict-id recall");

    nex.calls.length = 0;
    nvidia.calls.length = 0;
    const partial = await runReviewerBenchmark({ protocols: PROTOCOLS, reviewers, seed: 5, liveAbort: true });
    expect(partial.partial).toBe(true);
    expect(partial.cells).toHaveLength(20);
    expect(nex.calls.length + nvidia.calls.length).toBe(20);
    expect(renderReviewerBenchmark(partial)).toContain("(partial)");
  });

  /**
   * The axis is part of cell identity, so it has to survive export and come back through rescore.
   * Without it in `BenchmarkOracle`, three axes collide on one `cellId` and the id-map sizes differ.
   */
  it("carries the axis through export and rescore", async () => {
    const nex = provider("nex", "nex-agi/a:free", benchmarkReply);
    const nvidia = provider("nvidia", "nvidia/a:free", benchmarkReply);
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const original = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 12,
      pairs: [pair],
    });
    expect(original.cells).toHaveLength(36);
    expect(new Set(original.cells.map((cell) => cell.oracle.cellId)).size).toBe(36);
    // Every oracle line carries its axis on the wire.
    const axesOnWire = original.oracleJsonl.trim().split("\n")
      .map((line) => (JSON.parse(line) as { axis: string }).axis);
    expect(new Set(axesOnWire)).toEqual(new Set(["correctness", "regression", "adversarial"]));

    const responseJsonl = original.cells.map((cell) => canonicalJsonLine({
      cellId: cell.oracle.cellId,
      raw: cell.rawContent,
      usage: cell.usage,
    })).join("");
    const rescored = await rescoreReviewerBenchmark({
      protocols: PROTOCOLS,
      packetJsonl: original.packetJsonl,
      oracleJsonl: original.oracleJsonl,
      responseJsonl,
      packetSha256: original.packetSha256,
      oracleSha256: original.oracleSha256,
      model: { provider: "nex", model: "nex-agi/a:free" },
      family: "nex-agi",
      seed: 12,
    });
    // Reconstruction restored each cell's own axis, not a default.
    const byId = new Map(original.cells.map((cell) => [cell.oracle.cellId, cell.oracle.axis]));
    expect(rescored.cells).toHaveLength(36);
    for (const cell of rescored.cells) expect(cell.oracle.axis).toBe(byId.get(cell.oracle.cellId));
  });

  /**
   * AC4's other half. The axis is part of cell identity, so an oracle arriving without a usable one
   * must be refused at the schema boundary — both an unknown string and the pre-P1.4 shape that has
   * no axis at all. Hashes are recomputed, so this observes the schema check and not the hash check.
   */
  it("refuses an imported oracle whose axis is absent or not a review axis", async () => {
    const nex = provider("nex", "nex-agi/a:free", benchmarkReply);
    const nvidia = provider("nvidia", "nvidia/a:free", benchmarkReply);
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const original = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 12,
      pairs: [pair],
    });
    const responseJsonl = original.cells.map((cell) => canonicalJsonLine({
      cellId: cell.oracle.cellId,
      raw: cell.rawContent,
      usage: cell.usage,
    })).join("");

    const rewriteOracles = (edit: (oracle: Record<string, unknown>) => void): string =>
      original.oracleJsonl.trim().split("\n").map((line) => {
        const oracle = JSON.parse(line) as Record<string, unknown>;
        edit(oracle);
        return canonicalJsonLine(oracle);
      }).join("");

    for (const oracleJsonl of [
      rewriteOracles((oracle) => { oracle["axis"] = "vibes"; }),
      rewriteOracles((oracle) => { delete oracle["axis"]; }),
    ]) {
      expect(oracleJsonl).not.toBe(original.oracleJsonl);
      await expect(rescoreReviewerBenchmark({
        protocols: PROTOCOLS,
        packetJsonl: original.packetJsonl,
        oracleJsonl,
        responseJsonl,
        packetSha256: original.packetSha256,
        oracleSha256: sha256Hex(oracleJsonl),
        model: { provider: "nex", model: "nex-agi/a:free" },
        family: "nex-agi",
        seed: 12,
      })).rejects.toThrow(/benchmark JSONL schema mismatch/);
    }
  });

  /**
   * MC9/AC8: widening the schedule must not redefine the numbers item 42 was accepted on, and the
   * preserved slice must be readable from the **persisted report** rather than by re-filtering it.
   * So this asserts `byAxis.correctness` itself, against a `correctness`-only run's headline
   * figures — which are team figures, `scoreTeamQuality` and `scoreTeamDiscrimination`.
   *
   * The reviewers are deliberately asymmetric: one finds in repetitions 1–2 and the other in 3, so
   * the team OR and the per-cell aggregate differ. Under a `byAxis` computed with `scoreQuality`
   * this check fails, which is the point — a per-cell slice printed beside a team aggregate is a
   * different statistic wearing the same name.
   */
  it("carries the correctness slice's team figures on the persisted report", async () => {
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const build = async (axes?: readonly ["correctness"]): Promise<Awaited<ReturnType<typeof runReviewerBenchmark>>> =>
      runReviewerBenchmark({
        protocols: PROTOCOLS,
        reviewers: [
          reviewer(provider("nex", "nex-agi/a:free", (request) => asymmetricReply("nex", request)), "nex-agi"),
          reviewer(provider("nvidia", "nvidia/a:free", (request) => asymmetricReply("nvidia", request)), "nvidia"),
        ],
        seed: 12,
        pairs: [pair],
        ...(axes === undefined ? {} : { axes }),
      });
    const all = await build();
    const only = await build(["correctness"]);
    const slice = all.byAxis["correctness"];
    expect(slice?.quality).toEqual(only.team);
    expect(slice?.discrimination).toEqual(only.teamDiscrimination);

    // The fixture has to be one on which the two statistics disagree, or the assertion above is
    // satisfied by an implementation that computed the wrong one.
    const cells = all.cells.filter((cell) => cell.oracle.axis === "correctness");
    expect(scoreQuality(cells).primaryRecall).not.toEqual(only.team.primaryRecall);
    expect(scoreQuality(cells)).toEqual(scoreQuality(only.cells));
  });

  it("does not hide one family's failures behind its sibling's completion", async () => {
    const fail = provider("nex", "nex-agi/a:free", () => Promise.reject(new Error("down")));
    const pass = provider("nvidia", "nvidia/a:free", () => reply('{"findings":[]}'));
    const report = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(fail, "nex-agi"), reviewer(pass, "nvidia")],
      seed: 8,
    });
    expect(report.team.scheduled).toBe(288);
    expect(report.team.completed).toBe(144);
    expect(report.team.transportFailures).toBe(144);
    expect(report.team.completionRate).toBe(0.5);
    expect(renderReviewerBenchmark(report)).toContain("transport=144/288 (50.0%)");
  });

  it("bounds each provider call with the configured timeout signal", async () => {
    const waitForAbort = (request: CompletionRequest): Promise<CompletionResponse> =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          reject(new Error("timed out"));
        }, { once: true });
      });
    const nex = provider("nex", "nex-agi/a:free", waitForAbort);
    const nvidia = provider("nvidia", "nvidia/a:free", waitForAbort);
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const report = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 4,
      pairs: [pair],
      axes: ["correctness"],
      cellTimeoutMs: 2,
    });
    expect(report.cells).toHaveLength(12);
    expect(report.cells.every((cell) => cell.outcome === "transport_failure")).toBe(true);
  });

  it("pins the live abort boundary at four versus five failures", async () => {
    const run = async (failures: number) => {
      let count = 0;
      const execute = (): Promise<CompletionResponse> => {
        count++;
        return count <= failures
          ? Promise.reject(new Error("transport"))
          : Promise.resolve(reply('{"findings":[]}'));
      };
      const nex = provider("nex", "nex-agi/a:free", execute);
      const nvidia = provider("nvidia", "nvidia/a:free", execute);
      return runReviewerBenchmark({
        protocols: PROTOCOLS,
        reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
        seed: 6,
        liveAbort: true,
      });
    };
    expect((await run(4)).cells).toHaveLength(288);
    expect((await run(5)).cells).toHaveLength(20);
  });

  it("selects two free JSON families deterministically and fails closed", () => {
    const nex = provider("openrouter", "unused", () => reply('{"findings":[]}'));
    const nvidia = provider("other", "unused", () => reply('{"findings":[]}'));
    const selected = selectBenchmarkReviewers([
      { provider: nex, models: [
        info("openrouter", "nex-agi/00-paid", "nex-agi", { inputCostPerM: 1 }),
        info("openrouter", "nex-agi/00-no-json", "nex-agi", { supportsJson: false }),
        info("openrouter", "nex-agi/z:free", "nex-agi"),
        info("openrouter", "nex-agi/a:free", "nex-agi"),
        info("openrouter", "nex-agi/Z:free", "nex-agi"),
      ] },
      { provider: nvidia, models: [info("other", "nvidia/x:free", "nvidia")] },
    ]);
    expect(selected.map((item) => item.model.model)).toEqual(["nex-agi/Z:free", "nvidia/x:free"]);
    expect(() => selectBenchmarkReviewers([
      { provider: nex, models: [info("openrouter", "nex-agi/a:free", "nex-agi")] },
    ])).toThrow("family nvidia");
  });

  it("rebuilds the same shuffled schedule from its seed", () => {
    const nex = provider("nex", "nex-agi/a:free", benchmarkReply);
    const nvidia = provider("nvidia", "nvidia/a:free", benchmarkReply);
    const reviewers = [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")] as const;
    const key = (cell: ReturnType<typeof buildBenchmarkSchedule>[number]) =>
      `${cell.pair.pairId}:${cell.label}:${cell.reviewer.family}:${String(cell.repetition)}`;
    const first = buildBenchmarkSchedule(reviewers, 42).map(key);
    const second = buildBenchmarkSchedule(reviewers, 42).map(key);
    const other = buildBenchmarkSchedule(reviewers, 43).map(key);
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    expect(first).not.toEqual([...first].sort());
    expect([...new Set(buildBenchmarkSchedule(reviewers, 42).map((cell) => cell.repetition))].sort())
      .toEqual([1, 2, 3]);
  });

  it("renders asymmetric model and team rates without swapping fields", async () => {
    const nex = provider("nex", "nex-agi/a:free", (request) => asymmetricReply("nex", request));
    const nvidia = provider("nvidia", "nvidia/a:free", (request) => asymmetricReply("nvidia", request));
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const report = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 10,
      pairs: [pair],
      axes: ["correctness"],
    });
    const summary = renderReviewerBenchmark(report);
    expect(summary).toContain("nex:nex-agi/nex-n2.5-pro:free: 66.7% primary recall, 33.3% strict-id recall, 33.3% false positives, 33.3% pair discrimination, 12 input + 66 output tokens, 33.00 output tokens/hit");
    expect(summary).toContain("nvidia:nvidia/nemotron:free: 33.3% primary recall, 33.3% strict-id recall, 0.0% false positives, 33.3% pair discrimination, 18 input + 42 output tokens, 42.00 output tokens/hit");
    expect(summary).toContain("team (all axes): 100.0% primary recall, 66.7% strict-id recall, 33.3% false positives, 66.7% pair discrimination");
    expect(summary).toContain("team tokens: 30 input + 108 output, 36.00 output tokens/hit");
  });

  /**
   * MC4 and MC9b, at the report rather than at `scoreAxisRecall`. A run that produced cells for one
   * axis must still persist and render the other two — that is the shape of the partial free-tier
   * run AC9 exists for, and keying the table on the axes *observed* makes it shrink in exactly the
   * case it is most needed. And the axis line carries the same three figures as `team (all axes)`,
   * pair discrimination included, so the two can be read against each other.
   */
  it("persists and renders every configured axis, including one that produced no cells", async () => {
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const report = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [
        reviewer(provider("nex", "nex-agi/a:free", (request) => asymmetricReply("nex", request)), "nex-agi"),
        reviewer(provider("nvidia", "nvidia/a:free", (request) => asymmetricReply("nvidia", request)), "nvidia"),
      ],
      seed: 10,
      pairs: [pair],
      axes: ["correctness"],
    });
    expect(new Set(report.cells.map((cell) => cell.oracle.axis))).toEqual(new Set(["correctness"]));
    expect(Object.keys(report.byAxis).sort()).toEqual(["adversarial", "correctness", "regression"]);
    expect(report.byAxis["adversarial"]?.uniqueHits).toBe(0);
    expect(report.byAxis["adversarial"]?.tokensPerUniqueHit).toBeNull();
    expect(report.byAxis["adversarial"]?.discrimination).toEqual({ eligible: 0, discriminated: 0, rate: null });

    const summary = renderReviewerBenchmark(report);
    expect(summary).toContain(
      `axis correctness: 100.0% primary recall, 33.3% false positives, 66.7% pair discrimination, 1 unique hits (${pair.pairId}), 138 tokens, 138.00 tokens/unique hit`);
    expect(summary).toContain(
      "axis adversarial: undefined primary recall, undefined false positives, undefined pair discrimination, 0 unique hits (none), 0 tokens, undefined tokens/unique hit");
    expect(summary).toContain("axis regression: undefined primary recall");
  });

  it("rescoring replays raw bodies through the production parser without provider access", async () => {
    const nex = provider("nex", "nex-agi/a:free", benchmarkReply);
    const nvidia = provider("nvidia", "nvidia/a:free", benchmarkReply);
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const original = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 12,
      pairs: [pair],
      axes: ["correctness"],
    });
    const responseJsonl = original.cells.map((cell) => canonicalJsonLine({
      cellId: cell.oracle.cellId,
      raw: cell.rawContent,
      usage: cell.usage,
    })).join("");
    expect(original.team.primaryRecall).toBe(1);
    expect(original.team.falsePositiveRate).toBe(0);
    expect(original.cells.filter((cell) => cell.findings.length > 0)
      .every((cell) => cell.findings[0]?.evidenceStrength === "strong")).toBe(true);
    const summary = renderReviewerBenchmark(original);
    expect(summary).toContain("Reviewer benchmark: 12/12 completed cells");
    expect(summary).toContain("nex:nex-agi/nex-n2.5-pro:free: 100.0% primary recall, 100.0% strict-id recall, 0.0% false positives, 100.0% pair discrimination");
    expect(summary).toContain("team (all axes): 100.0% primary recall, 100.0% strict-id recall, 0.0% false positives, 100.0% pair discrimination");
    expect(summary).toContain("team tokens: 120 input + 150 output, 50.00 output tokens/hit");
    expect(summary).toContain("failures: schema=0/12 (0.0%), transport=0/12 (0.0%)");
    const rescored = await rescoreReviewerBenchmark({
      protocols: PROTOCOLS,
      packetJsonl: original.packetJsonl,
      oracleJsonl: original.oracleJsonl,
      responseJsonl,
      packetSha256: original.packetSha256,
      oracleSha256: original.oracleSha256,
      model: { provider: "external", model: "flagship" },
      family: "external",
      seed: 12,
    });
    expect(rescored.team).toEqual(original.team);
    expect(rescored.teamDiscrimination).toEqual(original.teamDiscrimination);
    expect(nex.calls.length + nvidia.calls.length).toBe(12);

    const withoutUsage = responseJsonl.trimEnd().split("\n").map((line, index) => {
      const value = JSON.parse(line) as { cellId: string; raw: string; usage?: unknown };
      if (index === 0) delete value.usage;
      return canonicalJsonLine(value);
    }).join("");
    const missingUsage = await rescoreReviewerBenchmark({
      protocols: PROTOCOLS,
      packetJsonl: original.packetJsonl,
      oracleJsonl: original.oracleJsonl,
      responseJsonl: withoutUsage,
      packetSha256: original.packetSha256,
      oracleSha256: original.oracleSha256,
      model: { provider: "external", model: "flagship" },
      family: "external",
      seed: 12,
    });
    expect(missingUsage.cells[0]?.usage).toBeNull();

    await expect(rescoreReviewerBenchmark({
      protocols: PROTOCOLS,
      packetJsonl: original.oracleJsonl,
      oracleJsonl: original.packetJsonl,
      responseJsonl,
      packetSha256: original.oracleSha256,
      oracleSha256: original.packetSha256,
      model: { provider: "external", model: "flagship" },
      family: "external",
      seed: 12,
    })).rejects.toThrow(/schema mismatch/);

    await expect(rescoreReviewerBenchmark({
      protocols: PROTOCOLS,
      packetJsonl: original.packetJsonl,
      oracleJsonl: original.oracleJsonl,
      responseJsonl,
      packetSha256: "0".repeat(64),
      oracleSha256: original.oracleSha256,
      model: { provider: "external", model: "flagship" },
      family: "external",
      seed: 12,
    })).rejects.toThrow("packet hash mismatch");

    await expect(rescoreReviewerBenchmark({
      protocols: PROTOCOLS,
      packetJsonl: original.packetJsonl,
      oracleJsonl: original.oracleJsonl,
      responseJsonl,
      packetSha256: original.packetSha256,
      oracleSha256: "0".repeat(64),
      model: { provider: "external", model: "flagship" },
      family: "external",
      seed: 12,
    })).rejects.toThrow("oracle hash mismatch");

    const firstResponse = responseJsonl.split("\n")[0];
    await expect(rescoreReviewerBenchmark({
      protocols: PROTOCOLS,
      packetJsonl: original.packetJsonl,
      oracleJsonl: original.oracleJsonl,
      responseJsonl: `${responseJsonl}${firstResponse}\n`,
      packetSha256: original.packetSha256,
      oracleSha256: original.oracleSha256,
      model: { provider: "external", model: "flagship" },
      family: "external",
      seed: 12,
    })).rejects.toThrow("duplicate benchmark cell");

    const packets = original.packetJsonl.trimEnd().split("\n").map((line) =>
      JSON.parse(line) as { cellId: string; system: string; user: string });
    packets[0] = { ...packets[0]!, user: `${packets[0]!.user}\nTAMPERED` };
    const tamperedPacket = packets.map(canonicalJsonLine).join("");
    await expect(rescoreReviewerBenchmark({
      protocols: PROTOCOLS,
      packetJsonl: tamperedPacket,
      oracleJsonl: original.oracleJsonl,
      responseJsonl,
      packetSha256: sha256Hex(tamperedPacket),
      oracleSha256: original.oracleSha256,
      model: { provider: "external", model: "flagship" },
      family: "external",
      seed: 12,
    })).rejects.toThrow("packet messages differ");

    await expect(rescoreReviewerBenchmark({
      protocols: PROTOCOLS,
      packetJsonl: original.packetJsonl.trimEnd(),
      oracleJsonl: original.oracleJsonl,
      responseJsonl,
      packetSha256: sha256Hex(original.packetJsonl.trimEnd()),
      oracleSha256: original.oracleSha256,
      model: { provider: "external", model: "flagship" },
      family: "external",
      seed: 12,
    })).rejects.toThrow("must end with a newline");
  });

  it("keeps corpus identity stable when rescore encounters pairs in shuffled order", async () => {
    const nex = provider("nex", "nex-agi/a:free", () => reply('{"findings":[]}'));
    const nvidia = provider("nvidia", "nvidia/a:free", () => reply('{"findings":[]}'));
    const pairs = REVIEWER_BENCHMARK_PAIRS.slice(0, 2);
    const original = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 17,
      pairs,
    });
    const responseJsonl = original.cells.map((cell) => canonicalJsonLine({
      cellId: cell.oracle.cellId,
      raw: cell.rawContent,
      usage: cell.usage,
    })).join("");
    const rescored = await rescoreReviewerBenchmark({
      protocols: PROTOCOLS,
      packetJsonl: original.packetJsonl,
      oracleJsonl: original.oracleJsonl,
      responseJsonl,
      packetSha256: original.packetSha256,
      oracleSha256: original.oracleSha256,
      model: { provider: "external", model: "flagship" },
      family: "external",
      seed: 17,
    });
    expect(rescored.corpusSha256).toBe(original.corpusSha256);
  });

  // P1.2 MC2/AC1: the benchmark is a token-heavy operator command and must be capped exactly as the
  // driver is. Round 1 found it uncapped.
  it("caps every benchmark reviewer call at review.maxOutputTokens", async () => {
    const nex = provider("nex", "nex-agi/a:free", () => reply('{"findings":[]}'));
    const nvidia = provider("nvidia", "nvidia/a:free", () => reply('{"findings":[]}'));
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 7,
      pairs: [pair],
      axes: ["correctness"],
    });

    const cap = ReviewStrategySchema.parse({}).maxOutputTokens;
    const all = [...nex.calls, ...nvidia.calls];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((request) => request.maxTokens === cap)).toBe(true);
  });

  // P1.2 MC2, AC11: a caller-supplied cap must be honoured, not silently replaced by the default.
  // Round 2 found the daemon passed nothing, so a configured value never reached the provider.
  it("honours a caller-supplied cap over the schema default", async () => {
    const nex = provider("nex", "nex-agi/a:free", () => reply('{"findings":[]}'));
    const nvidia = provider("nvidia", "nvidia/a:free", () => reply('{"findings":[]}'));
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 7,
      pairs: [pair],
      axes: ["correctness"],
      maxOutputTokens: 777,
    });

    const all = [...nex.calls, ...nvidia.calls];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((request) => request.maxTokens === 777)).toBe(true);
  });

  // P1.2 MC8a, AC12: the export side must record the live finish reason. Round 2 found only the import
  // side read it, so a live truncation still rescored as a completed cell.
  it("records the live finish reason on the recorded cell", async () => {
    const nex = provider("nex", "nex-agi/a:free", () => ({ ...reply('{"findings":[]}'), finishReason: "length" as const }));
    const nvidia = provider("nvidia", "nvidia/a:free", () => ({ ...reply('{"findings":[]}'), finishReason: "length" as const }));
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const report = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 12,
      pairs: [pair],
      axes: ["correctness"],
    });

    expect(report.cells.length).toBeGreaterThan(0);
    expect(report.cells.every((cell) => cell.finishReason === "length")).toBe(true);
  });

  // P1.2 MC8/fix 3: replay must not turn a truncation into a completion. Exported packets carry the
  // finish reason; packets recorded before truncation was detected default to "stop".
  it("preserves a truncated finish reason through rescore", async () => {
    const nex = provider("nex", "nex-agi/a:free", () => reply('{"findings":[]}'));
    const nvidia = provider("nvidia", "nvidia/a:free", () => reply('{"findings":[]}'));
    const pair = REVIEWER_BENCHMARK_PAIRS[0];
    if (pair === undefined) throw new Error("missing benchmark pair");
    const original = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 12,
      pairs: [pair],
      axes: ["correctness"],
    });

    const truncated = original.cells.map((cell) => canonicalJsonLine({
      cellId: cell.oracle.cellId,
      raw: cell.rawContent,
      usage: cell.usage,
      finishReason: "length",
    })).join("");
    const rescored = await rescoreReviewerBenchmark({
      protocols: PROTOCOLS,
      packetJsonl: original.packetJsonl,
      oracleJsonl: original.oracleJsonl,
      responseJsonl: truncated,
      packetSha256: original.packetSha256,
      oracleSha256: original.oracleSha256,
      model: { provider: "external", model: "flagship" },
      family: "external",
      seed: 12,
    });

    // Every cell was a truncation, so none may be scored as a completed review.
    expect(rescored.cells.every((cell) => cell.outcome !== "completed_empty" && cell.outcome !== "completed_with_findings")).toBe(true);
    expect(rescored.cells.every((cell) => cell.findings.length === 0)).toBe(true);
  });
});

interface TestProvider extends ProviderAdapter {
  calls: CompletionRequest[];
}

function provider(
  id: string,
  model: string,
  execute: (request: CompletionRequest) => CompletionResponse | Promise<CompletionResponse>,
): TestProvider {
  const calls: CompletionRequest[] = [];
  return {
    id,
    kind: "scripted",
    concurrency: 1,
    calls,
    listModels: () => Promise.resolve([info(id, model, model.split("/")[0] ?? id)]),
    complete: async (request) => {
      calls.push(structuredClone(request));
      return execute(request);
    },
    health: () => Promise.resolve({ ok: true, checkedAt: 1 }),
  };
}

function reviewer(value: TestProvider, family: string): BenchmarkReviewer {
  const listed = value.id === "nex"
    ? "nex-agi/nex-n2.5-pro:free"
    : value.id === "nvidia"
      ? "nvidia/nemotron:free"
      : `${family}/a:free`;
  return { provider: value, model: { provider: value.id, model: listed }, family };
}

function info(
  providerId: string,
  model: string,
  family: string,
  overrides: Partial<ModelInfo["capabilities"]> = {},
): ModelInfo {
  return {
    ref: { provider: providerId, model },
    displayName: model,
    capabilities: {
      contextWindow: 32_000,
      maxOutputTokens: 2_000,
      supportsTools: false,
      supportsJson: true,
      inputCostPerM: 0,
      outputCostPerM: 0,
      tier: "fast",
      family,
      ...overrides,
    },
    source: "provider",
  };
}

function reply(content: string, inputTokens = 10, outputTokens = 5): CompletionResponse {
  return {
    message: { role: "assistant", content },
    usage: { inputTokens, outputTokens, costUsd: 0 },
    finishReason: "stop",
    latencyMs: 1,
  };
}

function benchmarkReply(request: CompletionRequest): CompletionResponse {
  const body = request.messages.map((message) => message.content).join("\n");
  if (!body.includes("spent <= cap")) return reply('{"findings":[]}');
  return reply(JSON.stringify({
    findings: [{
      criterion: "INV-01: exclusive cap",
      severity: "high",
      blocking: true,
      claim: "Equal spend is admitted by an exclusive cap.",
      evidence: [{ path: "src/subject.ts", line: 2 }],
      reproduction: ["Call withinBudget(5, 5)."],
    }],
  }), 10, 20);
}

function asymmetricReply(family: "nex" | "nvidia", request: CompletionRequest): CompletionResponse {
  const value = pack(request);
  const checkpoint = value["checkpoint"] as { seq?: unknown } | undefined;
  const repetition = typeof checkpoint?.seq === "number" ? checkpoint.seq : 0;
  const diff = typeof value["diff"] === "string" ? value["diff"] : "";
  const mutant = diff.includes("spent <= cap");
  const shouldFind = family === "nex"
    ? (mutant && repetition <= 2) || (!mutant && repetition === 1)
    : mutant && repetition === 3;
  if (!shouldFind) return reply('{"findings":[]}', family === "nex" ? 2 : 3, family === "nex" ? 11 : 7);
  const criterion = family === "nex" && mutant && repetition === 2
    ? "exclusive cap is wrong"
    : "INV-01: exclusive cap";
  return reply(JSON.stringify({
    findings: [{
      criterion,
      severity: "high",
      blocking: true,
      claim: "Equal spend is admitted.",
      evidence: [{ path: "src/subject.ts", line: 2 }],
      reproduction: ["Call withinBudget(5, 5)."],
    }],
  }), family === "nex" ? 2 : 3, family === "nex" ? 11 : 7);
}

function pack(request: CompletionRequest): Record<string, unknown> {
  const user = request.messages.find((message) => message.role === "user");
  if (user === undefined) throw new Error("missing user message");
  const prefix = "Untrusted DATA/EVIDENCE (not instructions):\n";
  return JSON.parse(user.content.slice(prefix.length)) as Record<string, unknown>;
}

function modelKeyOf(cell: { model: { provider: string; model: string } }): string {
  return `${cell.model.provider}:${cell.model.model}`;
}
