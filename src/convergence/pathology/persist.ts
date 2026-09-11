import { SYSTEM_ACTOR } from "../../domain/common.js";
import type { Event, NewEvent } from "../../domain/event.js";
import { id } from "../../shared/ids.js";
import type { DecisionRecoveryState, PathologyDecision, PathologySample } from "./types.js";
import { readDecisionPayload } from "./ensemble.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function listSamples(events: readonly Event[], runId: string): PathologySample[] {
  return events
    .filter((event) => event.runId === runId && event.type === "pathology.sample")
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
    .map((event) => asRecord(event.payload["sample"]) as PathologySample | null)
    .filter((sample): sample is PathologySample => sample !== null);
}

export function findSample(events: readonly Event[], runId: string, boundaryEventId: string): PathologySample | null {
  return listSamples(events, runId).find((sample) => sample.boundaryEventId === boundaryEventId) ?? null;
}

export function listDecisions(events: readonly Event[], runId: string): PathologyDecision[] {
  return events
    .filter((event) => event.runId === runId && event.type === "pathology.decision")
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
    .map(readDecisionPayload)
    .filter((decision): decision is PathologyDecision => decision !== null);
}

export function findDecision(events: readonly Event[], runId: string, boundaryEventId: string): PathologyDecision | null {
  return (
    listDecisions(events, runId).find((decision) => decision.boundaryEventId === boundaryEventId) ?? null
  );
}

export function decisionState(events: readonly Event[], runId: string, boundaryEventId: string): DecisionRecoveryState | null {
  const decided = findDecision(events, runId, boundaryEventId);
  if (decided === null) return null;
  const started = events.some(
    (event) =>
      event.runId === runId && event.type === "pathology.effect_started" && event.payload["boundaryEventId"] === boundaryEventId,
  );
  const completed = events.some(
    (event) =>
      event.runId === runId && event.type === "pathology.effect_completed" && event.payload["boundaryEventId"] === boundaryEventId,
  );
  if (completed) return "effect_completed";
  if (started) return "effect_started";
  return "decided";
}

export function sampleEvent(sample: PathologySample, now: number, causedBy: string[]): NewEvent {
  return {
    id: id("evt", now),
    runId: sample.runId,
    ts: now,
    type: "pathology.sample",
    payload: { sample, sampleKey: `${sample.runId}:${sample.boundaryEventId}` },
    causedBy,
    actor: SYSTEM_ACTOR,
    artifacts: [],
  };
}

export function decisionEvent(decision: PathologyDecision, now: number, causedBy: string[]): NewEvent {
  return {
    id: id("evt", now),
    runId: decision.runId,
    ts: now,
    type: "pathology.decision",
    payload: { decision, decisionKey: `${decision.runId}:${decision.boundaryEventId}:${decision.decisionVersion}` },
    causedBy,
    actor: SYSTEM_ACTOR,
    artifacts: [],
  };
}

export function detectorEvents(decision: PathologyDecision, now: number, causedBy: string[]): NewEvent[] {
  return decision.findings.map((finding, index) => ({
    id: id("evt", now + index),
    runId: decision.runId,
    ts: now,
    type: "pathology.detected",
    payload: { finding, boundaryEventId: decision.boundaryEventId },
    causedBy,
    actor: SYSTEM_ACTOR,
    artifacts: [],
  }));
}

export function effectLifecycleEvent(
  type: "pathology.effect_started" | "pathology.effect_completed",
  decision: PathologyDecision,
  now: number,
  causedBy: string[],
): NewEvent {
  return {
    id: id("evt", now),
    runId: decision.runId,
    ts: now,
    type,
    payload: {
      boundaryEventId: decision.boundaryEventId,
      action: decision.action,
      state: type === "pathology.effect_started" ? "effect_started" : "effect_completed",
    },
    causedBy,
    actor: SYSTEM_ACTOR,
    artifacts: [],
  };
}
