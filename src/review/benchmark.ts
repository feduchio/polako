import type { ChatMessage, Usage } from "../broker/types.js";
import type { ModelRef } from "../domain/common.js";
import type { ReviewedFinding } from "./swarm.js";

export type BenchmarkLabel = "clean" | "mutant";
export type BenchmarkOutcomeKind =
  | "completed_empty"
  | "completed_with_findings"
  | "schema_failure"
  | "transport_failure";

export interface BenchmarkOracle {
  cellId: string;
  pairId: string;
  label: BenchmarkLabel;
  criterionId: string;
  path: string;
  line: number;
  endLine: number;
  repetition: number;
}

export interface BenchmarkCellResult {
  oracle: BenchmarkOracle;
  model: ModelRef;
  family: string;
  outcome: BenchmarkOutcomeKind;
  findings: readonly ReviewedFinding[];
  usage: Usage | null;
}

export interface WilsonInterval {
  low: number;
  high: number;
}

export interface QualityMetrics {
  scheduled: number;
  completed: number;
  mutantCompleted: number;
  cleanCompleted: number;
  primaryHits: number;
  strictIdHits: number;
  falsePositives: number;
  transportFailures: number;
  schemaFailures: number;
  inputTokens: number;
  outputTokens: number;
  completionRate: number | null;
  primaryRecall: number | null;
  strictIdRecall: number | null;
  falsePositiveRate: number | null;
  primaryRecallWilson95: WilsonInterval | null;
  falsePositiveWilson95: WilsonInterval | null;
  outputTokensPerPrimaryHit: number | null;
}

export interface PairDiscrimination {
  eligible: number;
  discriminated: number;
  rate: number | null;
}

export function primaryHit(
  findings: readonly ReviewedFinding[],
  oracle: BenchmarkOracle,
): boolean {
  return findings.some((finding) =>
    finding.blocking &&
    finding.evidence.some((ref) =>
      normalizePath(ref.path) === normalizePath(oracle.path) &&
      ref.line !== undefined &&
      overlaps(ref.line, ref.endLine ?? ref.line, oracle.line, oracle.endLine)));
}

export function strictIdHit(
  findings: readonly ReviewedFinding[],
  oracle: BenchmarkOracle,
): boolean {
  if (!primaryHit(findings, oracle)) return false;
  const escaped = oracle.criterionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i");
  return findings.some((finding) =>
    finding.blocking &&
    pattern.test(finding.criterion) &&
    finding.evidence.some((ref) =>
      normalizePath(ref.path) === normalizePath(oracle.path) &&
      ref.line !== undefined &&
      overlaps(ref.line, ref.endLine ?? ref.line, oracle.line, oracle.endLine)));
}

export function scoreQuality(cells: readonly BenchmarkCellResult[]): QualityMetrics {
  let completed = 0;
  let mutantCompleted = 0;
  let cleanCompleted = 0;
  let primaryHits = 0;
  let strictIdHits = 0;
  let falsePositives = 0;
  let transportFailures = 0;
  let schemaFailures = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const cell of cells) {
    if (cell.usage !== null) {
      inputTokens += cell.usage.inputTokens;
      outputTokens += cell.usage.outputTokens;
    }
    if (cell.outcome === "transport_failure") {
      transportFailures++;
      continue;
    }
    if (cell.outcome === "schema_failure") {
      schemaFailures++;
      continue;
    }
    completed++;
    const hit = primaryHit(cell.findings, cell.oracle);
    if (cell.oracle.label === "mutant") {
      mutantCompleted++;
      if (hit) primaryHits++;
      if (strictIdHit(cell.findings, cell.oracle)) strictIdHits++;
    } else {
      cleanCompleted++;
      if (hit) falsePositives++;
    }
  }

  return {
    scheduled: cells.length,
    completed,
    mutantCompleted,
    cleanCompleted,
    primaryHits,
    strictIdHits,
    falsePositives,
    transportFailures,
    schemaFailures,
    inputTokens,
    outputTokens,
    completionRate: ratio(completed, cells.length),
    primaryRecall: ratio(primaryHits, mutantCompleted),
    strictIdRecall: ratio(strictIdHits, mutantCompleted),
    falsePositiveRate: ratio(falsePositives, cleanCompleted),
    primaryRecallWilson95: wilson95(primaryHits, mutantCompleted),
    falsePositiveWilson95: wilson95(falsePositives, cleanCompleted),
    outputTokensPerPrimaryHit: ratio(outputTokens, primaryHits),
  };
}

export function scorePerModelDiscrimination(cells: readonly BenchmarkCellResult[]): PairDiscrimination {
  const groups = groupCells(cells, (cell) =>
    `${cell.oracle.pairId}\0${cell.model.provider}:${cell.model.model}\0${String(cell.oracle.repetition)}`);
  return discrimination(groups);
}

export function scoreTeamDiscrimination(cells: readonly BenchmarkCellResult[]): PairDiscrimination {
  const groups = groupCells(cells, (cell) =>
    `${cell.oracle.pairId}\0${String(cell.oracle.repetition)}`);
  return discrimination(groups);
}

export function scoreTeamQuality(cells: readonly BenchmarkCellResult[]): QualityMetrics {
  const groups = groupCells(cells, (cell) =>
    `${cell.oracle.pairId}\0${cell.oracle.label}\0${String(cell.oracle.repetition)}`);
  const teamCells: BenchmarkCellResult[] = [];
  for (const grouped of groups.values()) {
    const first = grouped[0];
    if (first === undefined) continue;
    const completed = grouped.filter(isCompleted);
    const usageValues = grouped.map((cell) => cell.usage).filter((usage): usage is Usage => usage !== null);
    const usage = usageValues.length === 0 ? null : {
      inputTokens: usageValues.reduce((sum, value) => sum + value.inputTokens, 0),
      outputTokens: usageValues.reduce((sum, value) => sum + value.outputTokens, 0),
      costUsd: usageValues.some((value) => value.costUsd === null)
        ? null
        : usageValues.reduce((sum, value) => sum + (value.costUsd ?? 0), 0),
    };
    teamCells.push({
      oracle: first.oracle,
      model: { provider: "team", model: "union" },
      family: "team",
      outcome: completed.length > 0
        ? completed.some((cell) => cell.findings.length > 0)
          ? "completed_with_findings"
          : "completed_empty"
        : grouped.some((cell) => cell.outcome === "schema_failure")
          ? "schema_failure"
          : "transport_failure",
      findings: completed.flatMap((cell) => cell.findings),
      usage,
    });
  }
  const quality = scoreQuality(teamCells);
  const accounting = scoreQuality(cells);
  return {
    ...quality,
    // Quality is an OR over the two-model team. Cost and failure accounting is not: every logical
    // cell was scheduled and paid for, even when its sibling model completed successfully.
    scheduled: accounting.scheduled,
    completed: accounting.completed,
    transportFailures: accounting.transportFailures,
    schemaFailures: accounting.schemaFailures,
    inputTokens: accounting.inputTokens,
    outputTokens: accounting.outputTokens,
    completionRate: accounting.completionRate,
    outputTokensPerPrimaryHit: ratio(accounting.outputTokens, quality.primaryHits),
  };
}

export function wilson95(successes: number, total: number): WilsonInterval | null {
  if (total === 0) return null;
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + z ** 2 / total;
  const center = (p + z ** 2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    p * (1 - p) / total + z ** 2 / (4 * total ** 2),
  ) / denominator;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export function canonicalJsonLine(value: unknown): string {
  return `${JSON.stringify(sortValue(value))}\n`;
}

export function exportedPacket(
  cellId: string,
  messages: readonly ChatMessage[],
): { cellId: string; system: string; user: string } {
  return {
    cellId,
    system: messages.find((message) => message.role === "system")?.content ?? "",
    user: messages.find((message) => message.role === "user")?.content ?? "",
  };
}

function discrimination(groups: ReadonlyMap<string, readonly BenchmarkCellResult[]>): PairDiscrimination {
  let eligible = 0;
  let discriminated = 0;
  for (const cells of groups.values()) {
    const mutant = cells.filter((cell) =>
      cell.oracle.label === "mutant" && isCompleted(cell));
    const clean = cells.filter((cell) =>
      cell.oracle.label === "clean" && isCompleted(cell));
    if (mutant.length === 0 || clean.length === 0) continue;
    eligible++;
    const mutantHit = mutant.some((cell) => primaryHit(cell.findings, cell.oracle));
    const cleanFalsePositive = clean.some((cell) => primaryHit(cell.findings, cell.oracle));
    if (mutantHit && !cleanFalsePositive) discriminated++;
  }
  return { eligible, discriminated, rate: ratio(discriminated, eligible) };
}

function isCompleted(cell: BenchmarkCellResult): boolean {
  return cell.outcome === "completed_empty" || cell.outcome === "completed_with_findings";
}

function groupCells(
  cells: readonly BenchmarkCellResult[],
  key: (cell: BenchmarkCellResult) => string,
): Map<string, BenchmarkCellResult[]> {
  const groups = new Map<string, BenchmarkCellResult[]>();
  for (const cell of cells) {
    const value = groups.get(key(cell)) ?? [];
    value.push(cell);
    groups.set(key(cell), value);
  }
  return groups;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.?\/*(?:[ab]\/)?/, "");
}

function overlaps(a: number, b: number, c: number, d: number): boolean {
  return a <= d && c <= b;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortValue(record[key])]));
}
