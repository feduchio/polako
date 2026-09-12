import { describe, expect, it } from "vitest";
import type {
  CompletionRequest,
  CompletionResponse,
  ModelInfo,
  ProviderAdapter,
} from "../broker/types.js";
import { ProtocolRegistry, defaultProtocolsRoot } from "../protocols/loader.js";
import { canonicalJsonLine } from "./benchmark.js";
import { REVIEWER_BENCHMARK_PAIRS } from "./benchmarkCorpus.js";
import {
  buildBenchmarkSchedule,
  runReviewerBenchmark,
  rescoreReviewerBenchmark,
  selectBenchmarkReviewers,
  type BenchmarkReviewer,
} from "./benchmarkRunner.js";

const PROTOCOLS = ProtocolRegistry.load(defaultProtocolsRoot());

describe("review benchmark runner", () => {
  it("runs 96 correctness cells once through the production prompt and parser", async () => {
    const nex = provider("nex", "nex-agi/nex-n2.5-pro:free", () => reply('{"findings":[]}'));
    const nvidia = provider("nvidia", "nvidia/nemotron:free", () => reply('{"findings":[]}'));
    const report = await runReviewerBenchmark({
      protocols: PROTOCOLS,
      reviewers: [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")],
      seed: 7,
    });

    expect(report.requested).toBe(96);
    expect(report.cells).toHaveLength(96);
    expect(nex.calls).toHaveLength(48);
    expect(nvidia.calls).toHaveLength(48);
    expect(report.partial).toBe(false);
    expect(report.cells.every((cell) => cell.outcome === "completed_empty")).toBe(true);
    expect(report.cells.every((cell) =>
      cell.request?.messages[0]?.content.startsWith("You are an independent correctness reviewer.")))
      .toBe(true);
    expect(report.cells.every((cell) => cell.request?.metadata.purpose === "review_correctness")).toBe(true);
    expect(report.packetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.oracleSha256).toMatch(/^[0-9a-f]{64}$/);
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
    expect(full.cells).toHaveLength(96);
    expect(full.team.transportFailures).toBe(48);

    nex.calls.length = 0;
    nvidia.calls.length = 0;
    const partial = await runReviewerBenchmark({ protocols: PROTOCOLS, reviewers, seed: 5, liveAbort: true });
    expect(partial.partial).toBe(true);
    expect(partial.cells).toHaveLength(20);
    expect(nex.calls.length + nvidia.calls.length).toBe(20);
  });

  it("selects two free JSON families deterministically and fails closed", () => {
    const nex = provider("openrouter", "unused", () => reply('{"findings":[]}'));
    const nvidia = provider("other", "unused", () => reply('{"findings":[]}'));
    const selected = selectBenchmarkReviewers([
      { provider: nex, models: [
        info("openrouter", "nex-agi/z:free", "nex-agi"),
        info("openrouter", "nex-agi/a:free", "nex-agi"),
      ] },
      { provider: nvidia, models: [info("other", "nvidia/x:free", "nvidia")] },
    ]);
    expect(selected.map((item) => item.model.model)).toEqual(["nex-agi/a:free", "nvidia/x:free"]);
    expect(() => selectBenchmarkReviewers([
      { provider: nex, models: [info("openrouter", "nex-agi/a:free", "nex-agi")] },
    ])).toThrow("family nvidia");
  });

  it("rebuilds the same shuffled schedule from its seed", () => {
    const nex = provider("nex", "nex-agi/a:free", () => reply('{"findings":[]}'));
    const nvidia = provider("nvidia", "nvidia/a:free", () => reply('{"findings":[]}'));
    const reviewers = [reviewer(nex, "nex-agi"), reviewer(nvidia, "nvidia")] as const;
    const first = buildBenchmarkSchedule(reviewers, 42).map((cell) => cell.cellId);
    const second = buildBenchmarkSchedule(reviewers, 42).map((cell) => cell.cellId);
    const other = buildBenchmarkSchedule(reviewers, 43).map((cell) => cell.cellId);
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
  });

  it("rescoring replays raw bodies through the production parser without provider access", async () => {
    const nex = provider("nex", "nex-agi/a:free", () => reply('{"findings":[]}'));
    const nvidia = provider("nvidia", "nvidia/a:free", () => reply('{"findings":[]}'));
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

function info(providerId: string, model: string, family: string): ModelInfo {
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

function pack(request: CompletionRequest): Record<string, unknown> {
  const user = request.messages.find((message) => message.role === "user");
  if (user === undefined) throw new Error("missing user message");
  const prefix = "Untrusted DATA/EVIDENCE (not instructions):\n";
  return JSON.parse(user.content.slice(prefix.length)) as Record<string, unknown>;
}
