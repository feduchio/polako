import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CompletionRequest,
  CompletionResponse,
  ModelInfo,
  ProviderAdapter,
} from "../broker/types.js";
import { REVIEWER_BENCHMARK_PAIRS, benchmarkCorpusSha256 } from "../review/benchmarkCorpus.js";
import { DaemonService } from "./service.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("benchmark.review RPC", () => {
  it("runs without a coding Run and persists separate packet/oracle artifacts", async () => {
    const home = mkdtempSync(join(tmpdir(), "polish-benchmark-service-"));
    cleanup.push(home);
    const nex = benchmarkProvider("nex", "nex-agi/a:free", "nex-agi");
    const nvidia = benchmarkProvider("nvidia", "nvidia/a:free", "nvidia");
    const service = new DaemonService({ home, providers: [nex, nvidia] });
    try {
      const result = await service.handle("benchmark.review", { seed: 9 }) as {
        summary: string;
        report: { requested: number; cells: unknown[]; corpusSha256: string };
        artifacts: {
          packet: { sha256: string };
          oracle: { sha256: string };
          report: { sha256: string };
        };
      };
      expect(result.summary).toContain("Reviewer benchmark: 96/96 completed cells");
      expect(result.report.requested).toBe(96);
      expect(result.report.corpusSha256).toBe(benchmarkCorpusSha256());
      expect(result.report.cells).toHaveLength(96);
      expect(nex.calls).toHaveLength(48);
      expect(nvidia.calls).toHaveLength(48);
      expect(service.store.repos.runs.listAll()).toEqual([]);
      expect(service.store.artifacts.has(result.artifacts.packet.sha256)).toBe(true);
      expect(service.store.artifacts.has(result.artifacts.oracle.sha256)).toBe(true);
      expect(service.store.artifacts.has(result.artifacts.report.sha256)).toBe(true);
      const packet = service.store.artifacts.getText(result.artifacts.packet.sha256);
      const oracle = service.store.artifacts.getText(result.artifacts.oracle.sha256);
      expect(JSON.parse(packet.split("\n")[0] ?? "{}")).toEqual(expect.objectContaining({
        cellId: expect.any(String),
        system: expect.any(String),
        user: expect.any(String),
      }));
      expect(packet).not.toContain('"label"');
      expect(JSON.parse(oracle.split("\n")[0] ?? "{}")).toEqual(expect.objectContaining({
        label: expect.stringMatching(/^(clean|mutant)$/),
        line: 2,
        endLine: 2,
      }));
      const oracleRows = oracle.trimEnd().split("\n").map((line) =>
        JSON.parse(line) as { pairId: string; criterionId: string });
      for (const pair of REVIEWER_BENCHMARK_PAIRS) {
        const rows = oracleRows.filter((row) => row.pairId === pair.pairId);
        expect(rows).toHaveLength(12);
        expect(new Set(rows.map((row) => row.criterionId))).toEqual(new Set([pair.criterionId]));
      }
    } finally {
      await service.close();
    }
  });

  it("fails before cell one when a required free family is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "polish-benchmark-family-"));
    cleanup.push(home);
    const nex = benchmarkProvider("nex", "nex-agi/a:free", "nex-agi");
    const service = new DaemonService({ home, providers: [nex] });
    try {
      await expect(service.handle("benchmark.review", { seed: 9 })).rejects.toThrow("family nvidia");
      expect(nex.calls).toHaveLength(0);
    } finally {
      await service.close();
    }
  });
});

interface BenchmarkProvider extends ProviderAdapter {
  calls: CompletionRequest[];
}

function benchmarkProvider(id: string, model: string, family: string): BenchmarkProvider {
  const calls: CompletionRequest[] = [];
  const info: ModelInfo = {
    ref: { provider: id, model },
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
  return {
    id,
    kind: "scripted",
    concurrency: 1,
    calls,
    listModels: () => Promise.resolve([info]),
    complete: (request) => {
      calls.push(structuredClone(request));
      return Promise.resolve(emptyResponse());
    },
    health: () => Promise.resolve({ ok: true, checkedAt: 1 }),
  };
}

function emptyResponse(): CompletionResponse {
  return {
    message: { role: "assistant", content: '{"findings":[]}' },
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
    finishReason: "stop",
    latencyMs: 1,
  };
}
