import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CompletionRequest,
  CompletionResponse,
  ModelInfo,
  ProviderAdapter,
} from "../broker/types.js";
import { ReviewStrategySchema } from "../domain/config.js";
import type { ModelRef } from "../domain/common.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import type { ProtocolRegistry } from "../protocols/loader.js";
import { sha256Hex } from "../shared/hash.js";
import { runAxisReview, type ReviewedFinding } from "./swarm.js";
import { DEFAULT_REVIEW_AXES } from "../domain/review.js";
import { ReviewAxisSchema, type ReviewAxis } from "../domain/finding.js";
import {
  canonicalJsonLine,
  exportedPacket,
  byTokensPerUniqueHit,
  scoreAxisRecall,
  scorePerModelDiscrimination,
  scoreQuality,
  scoreTeamDiscrimination,
  scoreTeamQuality,
  type AxisRecall,
  type BenchmarkCellResult,
  type BenchmarkLabel,
  type BenchmarkOracle,
  type BenchmarkOutcomeKind,
  type PairDiscrimination,
  type QualityMetrics,
} from "./benchmark.js";
import {
  REVIEWER_BENCHMARK_PAIRS,
  addedFileDiff,
  benchmarkCorpusSha256,
  changedLineSpan,
  sourceFor,
  type ReviewerBenchmarkPair,
} from "./benchmarkCorpus.js";

export interface BenchmarkReviewer {
  provider: ProviderAdapter;
  model: ModelRef;
  family: string;
  /** `review.maxOutputTokens`; the rescore harness must cap exactly as the live run did. */
  maxOutputTokens?: number;
}

export interface ScheduledBenchmarkCell {
  cellId: string;
  axis: ReviewAxis;
  pair: ReviewerBenchmarkPair;
  label: BenchmarkLabel;
  reviewer: BenchmarkReviewer;
  repetition: number;
}

export interface RecordedBenchmarkCell extends BenchmarkCellResult {
  /** Live finish reason, so an exported packet replays as the truncation it was. */
  finishReason?: CompletionResponse["finishReason"] | null;
  request: CompletionRequest | null;
  rawContent: string | null;
  error: string | null;
}

export interface ReviewerBenchmarkReport {
  seed: number;
  transportMode: "legacy_json_object" | "strict_schema" | null;
  configuration: "original" | "operational_strict" | null;
  corpusSha256: string;
  requested: number;
  partial: boolean;
  cells: RecordedBenchmarkCell[];
  byModel: Record<string, QualityMetrics>;
  byModelDiscrimination: Record<string, PairDiscrimination>;
  team: QualityMetrics;
  /** Per-axis unique recall; keyed by `ReviewAxis`. See `scoreAxisRecall`. */
  byAxis: Record<string, AxisRecall>;
  perModelDiscrimination: PairDiscrimination;
  teamDiscrimination: PairDiscrimination;
  packetJsonl: string;
  oracleJsonl: string;
  packetSha256: string;
  oracleSha256: string;
}

export interface RunReviewerBenchmarkInput {
  protocols: ProtocolRegistry;
  reviewers: readonly [BenchmarkReviewer, BenchmarkReviewer];
  seed: number;
  liveAbort?: boolean;
  transportMode?: "legacy_json_object" | "strict_schema";
  configuration?: "original" | "operational_strict";
  cellTimeoutMs?: number;
  /** `review.maxOutputTokens`. Defaults to the schema default so the benchmark is never uncapped. */
  maxOutputTokens?: number;
  onCell?: (cell: RecordedBenchmarkCell, completed: number, requested: number) => void;
  pairs?: readonly ReviewerBenchmarkPair[];
  /** Defaults to `DEFAULT_REVIEW_AXES`. Subsets the schedule exactly as `pairs` does. */
  axes?: readonly ReviewAxis[];
}

export interface ImportedBenchmarkResponse {
  cellId: string;
  raw: string;
  usage?: CompletionResponse["usage"];
  /**
   * Absent in packets exported before reviewer truncation was detected. Defaulting to `"stop"` keeps
   * those replayable, but a packet recorded from a truncated response must carry `"length"` or the
   * rescore turns a truncation into a completion.
   */
  finishReason?: CompletionResponse["finishReason"];
}

export interface RescoreReviewerBenchmarkInput {
  protocols: ProtocolRegistry;
  packetJsonl: string;
  oracleJsonl: string;
  responseJsonl: string;
  packetSha256: string;
  oracleSha256: string;
  model: ModelRef;
  family: string;
  seed: number;
  /** `review.maxOutputTokens`; the rescore harness must cap exactly as the live run did. */
  maxOutputTokens?: number;
}

interface Capture {
  request: CompletionRequest | null;
  response: CompletionResponse | null;
  error: unknown;
}

export async function runReviewerBenchmark(
  input: RunReviewerBenchmarkInput,
): Promise<ReviewerBenchmarkReport> {
  const schedule = buildBenchmarkSchedule(
    input.reviewers,
    input.seed,
    input.pairs ?? REVIEWER_BENCHMARK_PAIRS,
    input.axes ?? DEFAULT_REVIEW_AXES,
  );
  const cells: RecordedBenchmarkCell[] = [];
  let partial = false;

  for (const scheduled of schedule) {
    const result = await runCell(
      scheduled,
      input.protocols,
      input.cellTimeoutMs ?? 30_000,
      input.transportMode ?? "strict_schema",
      input.maxOutputTokens ?? ReviewStrategySchema.parse({}).maxOutputTokens,
    );
    cells.push(result);
    input.onCell?.(result, cells.length, schedule.length);
    if (
      input.liveAbort === true &&
      cells.length === 20 &&
      cells.filter((cell) => cell.outcome === "transport_failure").length > 4
    ) {
      partial = true;
      break;
    }
  }

  return buildReport(
    input.seed,
    benchmarkCorpusSha256(input.pairs ?? REVIEWER_BENCHMARK_PAIRS),
    schedule.length,
    partial,
    cells,
    input.transportMode ?? "strict_schema",
    input.configuration ?? "original",
  );
}

export function buildBenchmarkSchedule(
  reviewers: readonly [BenchmarkReviewer, BenchmarkReviewer],
  seed: number,
  pairs: readonly ReviewerBenchmarkPair[] = REVIEWER_BENCHMARK_PAIRS,
  axes: readonly ReviewAxis[] = DEFAULT_REVIEW_AXES,
): ScheduledBenchmarkCell[] {
  const cells: ScheduledBenchmarkCell[] = [];
  for (const pair of pairs) {
    for (const label of ["clean", "mutant"] as const) {
      for (const reviewer of reviewers) {
        for (let repetition = 1; repetition <= 3; repetition++) {
          // Defaulted from `DEFAULT_REVIEW_AXES` at the caller, not a local list: the benchmark
          // and production must not be able to disagree about what the axes are.
          for (const axis of axes) {
            cells.push({
              cellId: sha256Hex(`${seed}:${pair.pairId}:${label}:${reviewer.model.provider}:${reviewer.model.model}:${repetition}:${axis}`).slice(0, 24),
              axis,
              pair,
              label,
              reviewer,
              repetition,
            });
          }
        }
      }
    }
  }
  return shuffled(cells, seed);
}

export function selectBenchmarkReviewers(
  catalogs: readonly { provider: ProviderAdapter; models: readonly ModelInfo[] }[],
): [BenchmarkReviewer, BenchmarkReviewer] {
  const select = (family: "nex-agi" | "nvidia"): BenchmarkReviewer => {
    const eligible = catalogs.flatMap(({ provider, models }) =>
      models.filter((model) =>
        model.capabilities.family === family &&
        model.capabilities.supportsJson &&
        model.capabilities.inputCostPerM === 0 &&
        model.capabilities.outputCostPerM === 0)
        .map((model) => ({ provider, model: model.ref, family })));
    eligible.sort((a, b) => {
      const left = `${a.model.provider}:${a.model.model}`;
      const right = `${b.model.provider}:${b.model.model}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const selected = eligible[0];
    if (selected === undefined) throw new Error(`no free JSON benchmark reviewer in family ${family}`);
    return selected;
  };
  return [select("nex-agi"), select("nvidia")];
}

export function selectOperationalBenchmarkReviewers(
  catalogs: readonly { provider: ProviderAdapter; models: readonly ModelInfo[] }[],
): [BenchmarkReviewer, BenchmarkReviewer] {
  const eligible = catalogs.flatMap(({ provider, models }) =>
    models
      .filter((model) =>
        model.capabilities.supportsStrictReviewSchema === true &&
        model.capabilities.inputCostPerM === 0 &&
        model.capabilities.outputCostPerM === 0)
      .map((model) => ({ provider, model })))
    .sort((a, b) =>
      compareText(a.model.capabilities.family, b.model.capabilities.family) ||
      compareText(modelKey(a.model.ref), modelKey(b.model.ref)));
  const selected: BenchmarkReviewer[] = [];
  const families = new Set<string>();
  for (const entry of eligible) {
    const family = entry.model.capabilities.family;
    if (families.has(family)) continue;
    selected.push({ provider: entry.provider, model: entry.model.ref, family });
    families.add(family);
    if (selected.length === 2) break;
  }
  const first = selected[0];
  const second = selected[1];
  if (first === undefined || second === undefined) {
    throw new Error("benchmark requires two distinct free probed-strict reviewer families");
  }
  return [first, second];
}

export function renderReviewerBenchmark(report: ReviewerBenchmarkReport): string {
  const schemaRate = ratioText(report.team.schemaFailures, report.team.scheduled);
  const transportRate = ratioText(report.team.transportFailures, report.team.scheduled);
  const lines = [
    `Reviewer benchmark: ${String(report.team.completed)}/${String(report.requested)} completed cells${report.partial ? " (partial)" : ""} [configuration=${report.configuration ?? "rescore"}, transport=${report.transportMode ?? "rescore"}]`,
    ...Object.entries(report.byModel).map(([model, score]) =>
      `${model}: ${formatRate(score.primaryRecall)} primary recall, ${formatRate(score.strictIdRecall)} strict-id recall, ${formatRate(score.falsePositiveRate)} false positives, ${formatRate(report.byModelDiscrimination[model]?.rate ?? null)} pair discrimination, ${String(score.inputTokens)} input + ${String(score.outputTokens)} output tokens, ${formatNumber(score.outputTokensPerPrimaryHit)} output tokens/hit`),
    `team (all axes): ${formatRate(report.team.primaryRecall)} primary recall, ${formatRate(report.team.strictIdRecall)} strict-id recall, ${formatRate(report.team.falsePositiveRate)} false positives, ${formatRate(report.teamDiscrimination.rate)} pair discrimination`,
    `team tokens: ${String(report.team.inputTokens)} input + ${String(report.team.outputTokens)} output, ${formatNumber(report.team.outputTokensPerPrimaryHit)} output tokens/hit`,
    `failures: schema=${String(report.team.schemaFailures)}/${String(report.team.scheduled)} (${schemaRate}), transport=${String(report.team.transportFailures)}/${String(report.team.scheduled)} (${transportRate})`,
    // Per axis, ordered by the cost P3.1 decides on. `null` sorts last.
    ...Object.values(report.byAxis).sort(byTokensPerUniqueHit).map((recall) =>
      `axis ${recall.axis}: ${formatRate(recall.quality.primaryRecall)} primary recall, ${formatRate(recall.quality.falsePositiveRate)} false positives, ${formatRate(recall.discrimination.rate)} pair discrimination, ${String(recall.uniqueHits)} unique hits (${recall.uniquePairIds.join(",") || "none"}), ${String(recall.inputTokens + recall.outputTokens)} tokens, ${formatNumber(recall.tokensPerUniqueHit)} tokens/unique hit`),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderReviewerBenchmarkComparison(reports: readonly ReviewerBenchmarkReport[]): string {
  return `${reports.map((report) => {
    const refs = [...new Set(report.cells.map((cell) => modelKey(cell.model)))].sort(compareText).join(",");
    return [
      `configuration=${report.configuration ?? "rescore"} transport=${report.transportMode ?? "rescore"} models=${refs}`,
      `completion=${String(report.team.completed)}/${String(report.team.scheduled)} schema=${String(report.team.schemaFailures)} transport_failures=${String(report.team.transportFailures)}`,
      `primary=${formatRate(report.team.primaryRecall)} strict=${formatRate(report.team.strictIdRecall)} false_positive=${formatRate(report.team.falsePositiveRate)} discrimination=${formatRate(report.teamDiscrimination.rate)}`,
    ].join(" ");
  }).join("\n")}\n`;
}

export async function rescoreReviewerBenchmark(
  input: RescoreReviewerBenchmarkInput,
): Promise<ReviewerBenchmarkReport> {
  if (sha256Hex(input.packetJsonl) !== input.packetSha256) throw new Error("benchmark packet hash mismatch");
  if (sha256Hex(input.oracleJsonl) !== input.oracleSha256) throw new Error("benchmark oracle hash mismatch");
  const packets = parseJsonl<ReturnType<typeof exportedPacket>>(input.packetJsonl, isPacket);
  const oracles = parseJsonl<BenchmarkOracle>(input.oracleJsonl, isOracle);
  const responses = parseJsonl<ImportedBenchmarkResponse>(input.responseJsonl, isImportedResponse);
  const packetById = uniqueByCellId(packets);
  const oracleById = uniqueByCellId(oracles);
  const responseById = uniqueByCellId(responses);
  if (
    packetById.size !== oracleById.size ||
    packetById.size !== responseById.size ||
    [...packetById.keys()].some((cellId) => !oracleById.has(cellId) || !responseById.has(cellId))
  ) {
    throw new Error("benchmark packet/oracle/response cell ids differ");
  }

  const cells: RecordedBenchmarkCell[] = [];
  for (const [cellId, packet] of packetById) {
    const oracle = oracleById.get(cellId);
    const imported = responseById.get(cellId);
    if (oracle === undefined || imported === undefined) throw new Error(`missing imported cell ${cellId}`);
    const pair = REVIEWER_BENCHMARK_PAIRS.find((candidate) => candidate.pairId === oracle.pairId);
    if (pair === undefined) throw new Error(`unknown benchmark pair ${oracle.pairId}`);
    const replay = replayProvider(input.model, imported);
    const scheduled: ScheduledBenchmarkCell = {
      cellId,
      axis: oracle.axis,
      pair,
      label: oracle.label,
      reviewer: { provider: replay, model: input.model, family: input.family },
      repetition: oracle.repetition,
    };
    const cell = await runCell(
    scheduled,
    input.protocols,
    30_000,
    "strict_schema",
    input.maxOutputTokens ?? ReviewStrategySchema.parse({}).maxOutputTokens,
  );
    if (
      cell.request?.messages[0]?.content !== packet.system ||
      cell.request.messages[1]?.content !== packet.user
    ) {
      throw new Error(`benchmark packet messages differ for ${cellId}`);
    }
    cells.push({ ...cell, usage: imported.usage ?? null });
  }
  const usedPairs = [...new Set(cells.map((cell) => cell.oracle.pairId))]
    .map((pairId) => REVIEWER_BENCHMARK_PAIRS.find((pair) => pair.pairId === pairId))
    .filter((pair): pair is ReviewerBenchmarkPair => pair !== undefined);
  return buildReport(input.seed, benchmarkCorpusSha256(usedPairs), cells.length, false, cells, null, null);
}

async function runCell(
  scheduled: ScheduledBenchmarkCell,
  protocols: ProtocolRegistry,
  timeoutMs: number,
  responseMode: "legacy_json_object" | "strict_schema",
  maxOutputTokens: number,
): Promise<RecordedBenchmarkCell> {
  const root = mkdtempSync(join(tmpdir(), "polish-review-benchmark-"));
  const path = join(root, scheduled.pair.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, sourceFor(scheduled.pair, scheduled.label), "utf8");
  const capture: Capture = { request: null, response: null, error: null };
  const provider = recordingProvider(scheduled.reviewer.provider, capture, timeoutMs);
  const span = changedLineSpan(scheduled.pair);
  const oracle: BenchmarkOracle = {
    cellId: scheduled.cellId,
    axis: scheduled.axis,
    pairId: scheduled.pair.pairId,
    label: scheduled.label,
    criterionId: scheduled.pair.criterionId,
    path: scheduled.pair.path,
    line: span.line,
    endLine: span.endLine,
    repetition: scheduled.repetition,
  };
  let findings: ReviewedFinding[] = [];
  let outcome: BenchmarkOutcomeKind;
  let error: string | null = null;
  try {
    const result = await runAxisReview({
      checkpoint: checkpoint(scheduled.pair.pairId, scheduled.repetition),
      axis: scheduled.axis,
      artifact: {
        commitHash: "a".repeat(40),
        diffBase: "b".repeat(40),
        diff: addedFileDiff(scheduled.pair, scheduled.label),
        checkpoint: checkpoint(scheduled.pair.pairId, scheduled.repetition),
      },
      provider: { provider, model: scheduled.reviewer.model },
      protocols,
      repositoryRoot: root,
      now: scheduled.repetition,
      responseMode,
      maxOutputTokens,
    });
    findings = result.findings;
    outcome = findings.length === 0 ? "completed_empty" : "completed_with_findings";
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
    outcome = capture.response === null ? "transport_failure" : "schema_failure";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return {
    oracle,
    model: scheduled.reviewer.model,
    family: scheduled.reviewer.family,
    outcome,
    findings,
    usage: capture.response?.usage ?? null,
    request: capture.request,
    rawContent: capture.response?.message.content ?? null,
    // Carried so an exported packet can replay as the truncation it was: without it a parsable
    // truncated body rescores as a completed cell.
    finishReason: capture.response?.finishReason ?? null,
    error,
  };
}

function buildReport(
  seed: number,
  corpusSha256: string,
  requested: number,
  partial: boolean,
  cells: RecordedBenchmarkCell[],
  transportMode: "legacy_json_object" | "strict_schema" | null,
  configuration: "original" | "operational_strict" | null,
): ReviewerBenchmarkReport {
  const byModel = Object.fromEntries(
    [...new Set(cells.map((cell) => modelKey(cell.model)))].sort().map((key) => [
      key,
      scoreQuality(cells.filter((cell) => modelKey(cell.model) === key)),
    ]),
  );
  const byModelDiscrimination = Object.fromEntries(
    Object.keys(byModel).map((key) => [
      key,
      scorePerModelDiscrimination(cells.filter((cell) => modelKey(cell.model) === key)),
    ]),
  );
  const byAxis = scoreAxisRecall(cells);
  const packetJsonl = cells.map((cell) =>
    canonicalJsonLine(exportedPacket(cell.oracle.cellId, cell.request?.messages ?? []))).join("");
  const oracleJsonl = cells.map((cell) => canonicalJsonLine(cell.oracle)).join("");
  return {
    seed,
    transportMode,
    configuration,
    corpusSha256,
    requested,
    partial,
    cells,
    byModel,
    byModelDiscrimination,
    byAxis,
    team: scoreTeamQuality(cells),
    perModelDiscrimination: scorePerModelDiscrimination(cells),
    teamDiscrimination: scoreTeamDiscrimination(cells),
    packetJsonl,
    oracleJsonl,
    packetSha256: sha256Hex(packetJsonl),
    oracleSha256: sha256Hex(oracleJsonl),
  };
}

function recordingProvider(inner: ProviderAdapter, capture: Capture, timeoutMs: number): ProviderAdapter {
  return {
    id: inner.id,
    kind: inner.kind,
    concurrency: inner.concurrency,
    listModels: (signal) => inner.listModels(signal),
    complete: async (request) => {
      capture.request = structuredClone(request);
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = request.signal === undefined
          ? timeout
          : AbortSignal.any([request.signal, timeout]);
        const response = await inner.complete({ ...request, signal });
        capture.response = structuredClone(response);
        return response;
      } catch (error) {
        capture.error = error;
        throw error;
      }
    },
    health: (signal) => inner.health(signal),
  };
}

function replayProvider(model: ModelRef, imported: ImportedBenchmarkResponse): ProviderAdapter {
  return {
    id: model.provider,
    kind: "record-replay",
    concurrency: 1,
    listModels: () => Promise.resolve([]),
    complete: () => Promise.resolve({
      message: { role: "assistant", content: imported.raw },
      usage: imported.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: null },
      finishReason: imported.finishReason ?? "stop",
      latencyMs: 0,
    }),
    health: () => Promise.resolve({ ok: true, checkedAt: 0 }),
  };
}

function checkpoint(pairId: string, repetition: number): Checkpoint {
  return {
    id: "cp_0000000000000000000000",
    runId: "run_0000000000000000000000",
    seq: repetition,
    commitHash: "a".repeat(40),
    parentId: null,
    source: "integration",
    taskId: "task_0000000000000000000000",
    evidence: {
      gates: {},
      testsPassed: 3,
      testsFailed: 0,
      testsTotal: 3,
      openValidatedFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      diffLinesFromBaseline: 1,
    },
    createdAt: repetition + pairId.length,
  };
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const out = [...values];
  let state = seed >>> 0;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let index = out.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [out[index], out[swap]] = [out[swap] as T, out[index] as T];
  }
  return out;
}

function modelKey(model: ModelRef): string {
  return `${model.provider}:${model.model}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function formatRate(value: number | null): string {
  return value === null ? "undefined" : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number | null): string {
  return value === null ? "undefined" : value.toFixed(2);
}

function ratioText(numerator: number, denominator: number): string {
  return denominator === 0 ? "undefined" : `${(numerator / denominator * 100).toFixed(1)}%`;
}

function parseJsonl<T>(text: string, accepts: (value: unknown) => value is T): T[] {
  if (!text.endsWith("\n")) throw new Error("benchmark JSONL must end with a newline");
  return text.slice(0, -1).split("\n").filter((line) => line !== "").map((line) => {
    const value: unknown = JSON.parse(line);
    if (!accepts(value)) throw new Error("benchmark JSONL schema mismatch");
    return value;
  });
}

function uniqueByCellId<T extends { cellId: string }>(values: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const value of values) {
    if (map.has(value.cellId)) throw new Error(`duplicate benchmark cell ${value.cellId}`);
    map.set(value.cellId, value);
  }
  return map;
}

function isPacket(value: unknown): value is ReturnType<typeof exportedPacket> {
  if (!isRecord(value)) return false;
  return typeof value["cellId"] === "string" &&
    typeof value["system"] === "string" &&
    typeof value["user"] === "string" &&
    Object.keys(value).length === 3;
}

function isOracle(value: unknown): value is BenchmarkOracle {
  if (!isRecord(value)) return false;
  return typeof value["cellId"] === "string" &&
    ReviewAxisSchema.safeParse(value["axis"]).success &&
    typeof value["pairId"] === "string" &&
    (value["label"] === "clean" || value["label"] === "mutant") &&
    typeof value["criterionId"] === "string" &&
    typeof value["path"] === "string" &&
    typeof value["line"] === "number" &&
    typeof value["endLine"] === "number" &&
    typeof value["repetition"] === "number";
}

function isImportedResponse(value: unknown): value is ImportedBenchmarkResponse {
  if (!isRecord(value)) return false;
  return typeof value["cellId"] === "string" && typeof value["raw"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
