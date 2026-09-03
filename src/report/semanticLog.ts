import type { Event } from "../domain/event.js";

export type WhyStage =
  | "mission"
  | "finding"
  | "validation"
  | "task"
  | "candidate"
  | "diff"
  | "checks"
  | "verdict"
  | "decision"
  | "other";

export interface WhyStep {
  eventId: string;
  seq: number;
  stage: WhyStage;
  summary: string;
  causedBy: string[];
}

/** Render an append-only event stream as a compact, human-readable timeline. */
export function renderSemanticLog(events: readonly Event[]): string {
  if (events.length === 0) return "No activity recorded.";
  return [...events]
    .sort(compareEvents)
    .map((event) => {
      const cause = event.causedBy.length === 0 ? "" : ` (because ${event.causedBy.join(", ")})`;
      return `${event.seq + 1}. ${summarizeEvent(event)}${cause}`;
    })
    .join("\n");
}

export const renderTimeline = renderSemanticLog;

/** Queryable semantic view over persisted events. */
export class SemanticEventLog {
  private readonly events: Event[];
  private readonly byId: Map<string, Event>;
  private readonly effects = new Map<string, Event[]>();

  constructor(events: readonly Event[]) {
    this.events = [...events].sort(compareEvents);
    this.byId = new Map(this.events.map((event) => [event.id, event]));
    for (const event of this.events) {
      for (const causeId of event.causedBy) {
        const values = this.effects.get(causeId) ?? [];
        values.push(event);
        this.effects.set(causeId, values);
      }
    }
  }

  render(): string {
    return renderSemanticLog(this.events);
  }

  /**
   * Return the connected causal story around an event or domain entity. The result is in
   * narrative order, so persisted causes appear before their effects.
   */
  whyChain(entityId: string): WhyStep[] {
    const seeds = this.events.filter((event) => event.id === entityId || containsValue(event.payload, entityId));
    if (seeds.length === 0) return [];
    const included = new Set<string>();
    const visitCauses = (event: Event): void => {
      if (included.has(event.id)) return;
      included.add(event.id);
      for (const causeId of event.causedBy) {
        const cause = this.byId.get(causeId);
        if (cause !== undefined) visitCauses(cause);
      }
    };
    const visitEffects = (event: Event): void => {
      if (!included.has(event.id)) included.add(event.id);
      for (const effect of this.effects.get(event.id) ?? []) {
        if (!included.has(effect.id)) {
          included.add(effect.id);
          visitEffects(effect);
        }
      }
    };
    for (const seed of seeds) {
      visitCauses(seed);
      visitEffects(seed);
    }
    return this.events
      .filter((event) => included.has(event.id))
      .map((event) => ({
        eventId: event.id,
        seq: event.seq,
        stage: stageFor(event.type),
        summary: summarizeEvent(event),
        causedBy: [...event.causedBy],
      }));
  }
}

export function whyChain(events: readonly Event[], entityId: string): WhyStep[] {
  return new SemanticEventLog(events).whyChain(entityId);
}

function summarizeEvent(event: Event): string {
  const subject = subjectFor(event);
  switch (event.type) {
    case "run.created": return `Run started${subject}`;
    case "run.phase_changed": return `Run moved to ${text(event.payload["to"] ?? event.payload["phase"], "next phase")}`;
    case "run.terminated": return `Run ended: ${text(event.payload["reason"] ?? event.payload["phase"], "terminal")}`;
    case "mission.recorded": return `Mission recorded${subject}`;
    case "mission.interpreted": return `Mission interpreted${subject}`;
    case "project.discovered": return `Project discovered${subject}`;
    case "baseline.snapshotted": return `Baseline captured${subject}`;
    case "finding.raised": return `Finding raised${subject}: ${text(event.payload["claim"], "review concern")}`;
    case "finding.validated": return `Finding validated${subject}: ${text(event.payload["verdict"], "verdict recorded")}`;
    case "finding.status_changed": return `Finding status changed${subject}: ${text(event.payload["to"], "updated")}`;
    case "task.created": return `Task created${subject}: ${text(event.payload["title"], entityTitle(event.payload["task"]))}`;
    case "task.state_changed": return `Task state changed${subject}: ${text(event.payload["to"], "updated")}`;
    case "candidate.created": return `Candidate created${subject}`;
    case "candidate.gated": return `Candidate checks completed${subject}: ${text(event.payload["verdict"] ?? event.payload["status"], "results recorded")}`;
    case "candidate.compared": return `Candidate verdict recorded${subject}: ${text(event.payload["winner"] ?? event.payload["verdict"], "comparison complete")}`;
    case "integration.finished": return `Integration finished${subject}: ${text(event.payload["status"], "complete")}`;
    case "checkpoint.created": return `Checkpoint created${subject}`;
    case "clean_round.recorded": return `Clean round recorded${subject}`;
    case "review.finished": return `Review finished${subject}`;
    case "supervisor.decision": return `Council decided ${text(event.payload["decision"], "outcome")}: ${text(event.payload["rationale"], "rationale recorded")}`;
    case "report.generated": return `Report generated${subject}`;
    case "model.call": return `Model call ${event.payload["ok"] === false ? "failed" : "completed"}: ${text(event.payload["purpose"], "unspecified purpose")}`;
    case "shell.command": return `Command completed: ${text(event.payload["command"], "shell command")}`;
    default: return `${event.type.replaceAll(".", " ")}${subject}`;
  }
}

function subjectFor(event: Event): string {
  const id = firstEntityId(event.payload);
  return id === undefined ? "" : ` [${id}]`;
}

function firstEntityId(payload: Record<string, unknown>): string | undefined {
  for (const key of ["missionId", "findingId", "validationId", "taskId", "candidateId", "checkpointId", "id"]) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  for (const key of ["mission", "interpretation", "finding", "validation", "task", "candidate", "checkpoint", "cleanRound"]) {
    const value = payload[key];
    if (isRecord(value) && typeof value["id"] === "string") return value["id"];
  }
  return undefined;
}

function stageFor(type: string): WhyStage {
  if (type.startsWith("mission.")) return "mission";
  if (type === "finding.validated" || type === "finding.status_changed") return "validation";
  if (type.startsWith("finding.")) return "finding";
  if (type.startsWith("task.")) return "task";
  if (type === "candidate.gated") return "checks";
  if (type === "candidate.compared") return "verdict";
  if (type.startsWith("candidate.")) return "candidate";
  if (type.startsWith("integration.") || type.startsWith("checkpoint.")) return "diff";
  if (type === "supervisor.decision") return "decision";
  return "other";
}

function containsValue(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((item) => containsValue(item, target));
  if (isRecord(value)) return Object.values(value).some((item) => containsValue(item, target));
  return false;
}

function entityTitle(value: unknown): string {
  return isRecord(value) ? text(value["title"], "planned work") : "planned work";
}

function text(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareEvents(a: Event, b: Event): number {
  return a.seq - b.seq || a.ts - b.ts || a.id.localeCompare(b.id);
}
