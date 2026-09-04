import { modelRefKey, type ModelRef } from "../../domain/common.js";
import type { CleanRound } from "../../domain/convergence.js";
import { preferRotatedEnsemble, type EnsembleOption } from "../tracker.js";
import type { Event } from "../../domain/event.js";
import type { PathologyDecision } from "./types.js";

export function selectEligibleEnsemble(input: {
  options: readonly EnsembleOption[];
  previous: readonly CleanRound[];
  checkpointHash: string;
  axes: readonly CleanRound["axes"][number][];
  minQualityForRotation: number;
  currentEnsemble: readonly ModelRef[];
}): ModelRef[] | null {
  const eligible = input.options.filter((option) => option.quality >= input.minQualityForRotation);
  if (eligible.length === 0) return null;
  const selected = preferRotatedEnsemble(eligible, input.previous, input.checkpointHash, input.axes, input.minQualityForRotation);
  if (selected === null) return null;
  const current = input.currentEnsemble.map(modelRefKey).sort().join("|");
  const next = selected.map(modelRefKey).sort().join("|");
  if (current === next && eligible.length < 2) return null;
  if (current === next) {
    const alternative = eligible.find((option) => option.ensemble.map(modelRefKey).sort().join("|") !== current);
    return alternative?.ensemble ?? null;
  }
  return selected;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readDecisionPayload(event: Event): PathologyDecision | null {
  if (event.type !== "pathology.decision") return null;
  const decision = asRecord(event.payload["decision"]) as PathologyDecision | null;
  return decision;
}

export function pendingEnsembleOverride(
  events: readonly Event[],
  checkpointHash: string,
  roundIndex: number,
): ModelRef[] | null {
  const completed = new Set(
    events
      .filter((event) => event.type === "pathology.effect_completed")
      .map((event) => {
        const boundaryEventId = event.payload["boundaryEventId"];
        return typeof boundaryEventId === "string" ? boundaryEventId : "";
      }),
  );
  const matches = events
    .map(readDecisionPayload)
    .filter((decision): decision is PathologyDecision => decision !== null)
    .filter(
      (decision) =>
        decision.action === "CHANGE_ENSEMBLE" &&
        decision.targetReviewRoundIndex === roundIndex &&
        completed.has(decision.boundaryEventId),
    );
  const latest = matches.at(-1);
  if (latest?.targetEnsemble === null || latest === undefined) return null;
  if (checkpointHash.length === 0) return latest.targetEnsemble;
  return latest.targetEnsemble;
}

export function orderReviewersByEnsemble<T extends { model: ModelRef }>(reviewers: readonly T[], ensemble: readonly ModelRef[]): T[] {
  const wanted = ensemble.map(modelRefKey);
  const byKey = new Map(reviewers.map((reviewer) => [modelRefKey(reviewer.model), reviewer]));
  const ordered: T[] = [];
  for (const key of wanted) {
    const reviewer = byKey.get(key);
    if (reviewer !== undefined) ordered.push(reviewer);
  }
  for (const reviewer of reviewers) {
    if (!wanted.includes(modelRefKey(reviewer.model))) ordered.push(reviewer);
  }
  return ordered;
}
