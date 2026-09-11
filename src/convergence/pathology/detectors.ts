import { PATHOLOGY_ORDER, type Pathology } from "../../domain/convergence.js";
import type { ConvergenceStrategy } from "../../domain/config.js";
import type { DetectorFinding, PathologySample, TaskWorkClassRecord } from "./types.js";
import { sampleKey } from "./types.js";
import { progressImproved } from "./sample.js";

export type ConvergenceKnobs = Pick<
  ConvergenceStrategy,
  | "findingOscillationWindow"
  | "checkpointOscillationWindow"
  | "noProgressAttempts"
  | "disagreementWindow"
  | "taskGrowthWindow"
>;

function windowOf<T>(items: readonly T[], size: number): T[] | null {
  if (items.length < size) return null;
  return items.slice(items.length - size);
}

function isAlternatingPair<T>(items: readonly T[], equal: (a: T, b: T) => boolean): boolean {
  if (items.length < 4 || items.length % 2 !== 0) return false;
  const a = items[0];
  const b = items[1];
  if (a === undefined || b === undefined || equal(a, b)) return false;
  for (let i = 0; i < items.length; i += 1) {
    const expected = i % 2 === 0 ? a : b;
    const actual = items[i];
    if (actual === undefined || !equal(actual, expected)) return false;
  }
  return true;
}

function keys(samples: readonly PathologySample[]): string[] {
  return samples.map((sample) => sampleKey(sample.runId, sample.boundaryEventId));
}

function legalOscillationWindow(windowSize: number): boolean {
  return Number.isInteger(windowSize) && windowSize >= 4 && windowSize % 2 === 0;
}

export function detectFindingOscillation(samples: readonly PathologySample[], windowSize: number): DetectorFinding | null {
  if (!legalOscillationWindow(windowSize)) return null;
  const window = windowOf(samples, windowSize);
  if (window === null) return null;
  const fingerprints = new Set(window.flatMap((sample) => sample.findingObservations.map((row) => row.fingerprint)));
  for (const fingerprint of [...fingerprints].sort()) {
    const statuses = window.map((sample) => {
      const latest = [...sample.findingObservations].reverse().find((row) => row.fingerprint === fingerprint);
      return latest?.status ?? null;
    });
    if (statuses.some((status) => status === null)) continue;
    if (isAlternatingPair(statuses as string[], (a, b) => a === b)) {
      return {
        kind: "finding_oscillation",
        sampleKeys: keys(window),
        evidenceRefs: window.flatMap((sample) =>
          sample.findingObservations.filter((row) => row.fingerprint === fingerprint).map((row) => row.causalEventId),
        ),
        reason: `finding ${fingerprint} oscillated A,B,A,B`,
      };
    }
  }
  return null;
}

export function detectCheckpointOscillation(samples: readonly PathologySample[], windowSize: number): DetectorFinding | null {
  if (!legalOscillationWindow(windowSize)) return null;
  const window = windowOf(samples, windowSize);
  if (window === null) return null;
  const hashes = window.map((sample) => sample.checkpointHash);
  if (hashes.some((hash) => hash === null)) return null;
  if (!isAlternatingPair(hashes as string[], (a, b) => a === b)) return null;
  return {
    kind: "checkpoint_oscillation",
    sampleKeys: keys(window),
    evidenceRefs: window.map((sample) => sample.boundaryEventId),
    reason: "checkpoint hashes oscillated A,B,A,B",
  };
}

export function detectNoProgress(
  samples: readonly PathologySample[],
  attempts: number,
  doneEligible: boolean,
): DetectorFinding | null {
  if (doneEligible) return null;
  if (!Number.isInteger(attempts) || attempts < 2) return null;
  const window = windowOf(samples, attempts);
  if (window === null) return null;
  const first = window[0];
  if (first === undefined) return null;
  for (let i = 1; i < window.length; i += 1) {
    const current = window[i];
    if (current === undefined) return null;
    const previous = window[i - 1];
    if (previous === undefined) return null;
    if (progressImproved(first.progress, current.progress) || progressImproved(previous.progress, current.progress)) {
      return null;
    }
  }
  return {
    kind: "no_progress",
    sampleKeys: keys(window),
    evidenceRefs: window.map((sample) => sample.boundaryEventId),
    reason: "canonical progress vector did not improve",
  };
}

export function detectDisagreement(samples: readonly PathologySample[], windowSize: number): DetectorFinding | null {
  const latest = samples.at(-1);
  if (latest?.checkpointHash == null) return null;
  const checkpoint = latest.checkpointHash;
  const rounds = latest.disagreementRounds.filter((round) => round.checkpointHash === checkpoint);
  if (rounds.length < windowSize) return null;
  const window = rounds.slice(rounds.length - windowSize);
  const first = window[0];
  const last = window.at(-1);
  if (first === undefined || last === undefined) return null;
  if (first.fingerprints.length === 0 || last.fingerprints.length === 0) return null;
  const firstSet = new Set(first.fingerprints);
  const lastIsStrictSubset =
    last.fingerprints.length < first.fingerprints.length && last.fingerprints.every((fingerprint) => firstSet.has(fingerprint));
  if (lastIsStrictSubset) return null;
  return {
    kind: "disagreement_not_shrinking",
    sampleKeys: keys(samples.slice(-1)),
    evidenceRefs: last.fingerprints,
    reason: "structured disagreement set is non-empty and not shrinking",
  };
}

function validStyleOnly(record: TaskWorkClassRecord): boolean {
  if (record.workClass !== "style_only") return false;
  if (record.kind !== "simplify" && record.kind !== "refactor") return false;
  if (record.originKind === "investigation") return false;
  if (record.originKind !== "mission_requirement" && record.originKind !== "valid_finding") return false;
  if (record.classifiedBy === null || record.sourceRef === null || record.classificationEventId === null) return false;
  return true;
}

export function detectStyleOnlyGrowth(samples: readonly PathologySample[], windowSize: number): DetectorFinding | null {
  if (!Number.isInteger(windowSize) || windowSize < 2) return null;
  const window = windowOf(samples, windowSize);
  if (window === null) return null;
  const first = window[0];
  const last = window.at(-1);
  if (first === undefined || last === undefined) return null;
  const prior = new Set(first.taskIds);
  const added = last.taskIds.filter((taskId) => !prior.has(taskId)).sort();
  if (added.length === 0) return null;
  const records = last.taskWorkClasses.filter((record) => added.includes(record.taskId));
  if (records.length !== added.length) return null;
  if (!records.every(validStyleOnly)) return null;
  return {
    kind: "task_graph_growth_from_nonblocking",
    sampleKeys: keys(window),
    evidenceRefs: added,
    reason: "task graph grew from style_only simplify/refactor work only",
  };
}

export function runDetectors(input: {
  samples: readonly PathologySample[];
  knobs: ConvergenceKnobs;
  doneEligible: boolean;
}): DetectorFinding[] {
  const findings: DetectorFinding[] = [];
  const finding = detectFindingOscillation(input.samples, input.knobs.findingOscillationWindow);
  const checkpoint = detectCheckpointOscillation(input.samples, input.knobs.checkpointOscillationWindow);
  const noProgress = detectNoProgress(input.samples, input.knobs.noProgressAttempts, input.doneEligible);
  const disagreement = detectDisagreement(input.samples, input.knobs.disagreementWindow);
  const growth = detectStyleOnlyGrowth(input.samples, input.knobs.taskGrowthWindow);
  for (const item of [finding, checkpoint, noProgress, disagreement, growth]) {
    if (item !== null) findings.push(item);
  }
  return findings.sort((a, b) => PATHOLOGY_ORDER.indexOf(a.kind) - PATHOLOGY_ORDER.indexOf(b.kind));
}

export function comparePathology(a: Pathology, b: Pathology): number {
  return PATHOLOGY_ORDER.indexOf(a) - PATHOLOGY_ORDER.indexOf(b);
}
