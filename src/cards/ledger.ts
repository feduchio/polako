import type { Event } from "../domain/event.js";
import { matchesAnyGlob } from "./glob.js";
import { reviewIndependenceOf, type ReviewExecution, type ReviewIndependence } from "../domain/review.js";
import type { Task, TaskState } from "../domain/task.js";
import { CARDS_REGISTERED_EVENT, CardRegistrationSchema, type CardRegistration } from "./types.js";

export type CardResult = "accepted" | "satisfied" | "failed" | "rejected" | "skipped" | "running" | "waiting";

export interface CardLedgerRow {
  card: string;
  title: string;
  result: CardResult;
  state: TaskState | "UNPLANNED";
  /** First 8 characters of the integration commit, or null. */
  commit: string | null;
  /** Wall-clock minutes from the first candidate to the task's end (or now, while it runs). */
  minutes: number | null;
  /** Seconds the model server spent swapping models while this card was active. */
  swapSeconds: number;
  /** Independence of the review that covered this card's checkpoint, or null when none ran. */
  reviewIndependence: ReviewIndependence | null;
  /** Who turned the card down first and with what: a gate, or a reviewer's first finding. */
  rejectedBy: { by: string; first: string } | null;
  note: string;
}

const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>(["INTEGRATED", "REJECTED", "CANCELLED", "SATISFIED", "BLOCKED", "SPLIT"]);

export function cardRegistrationFromEvents(events: readonly Event[]): CardRegistration | null {
  const registered = [...events].reverse().find((event) => event.type === CARDS_REGISTERED_EVENT);
  if (registered === undefined) return null;
  const parsed = CardRegistrationSchema.safeParse(registered.payload["registration"]);
  return parsed.success ? parsed.data : null;
}

interface CandidateView {
  taskId: string;
  model: { provider: string; model: string };
  gateReport: { failures: { reason: string; detail: string }[] } | null;
  error: string | null;
}

interface FindingView {
  checkpointHash: string;
  blocking: boolean;
  claim: string;
  evidence?: { path?: string }[];
  reportedBy: { model?: { provider: string; model: string } };
}

/**
 * The per-card ledger of a card run, read from the event log alone (so it works on a live run, a
 * finished one and a restored one). `null` for a mission run.
 */
export function projectCardLedger(events: readonly Event[], now: number): CardLedgerRow[] | null {
  const registration = cardRegistrationFromEvents(events);
  if (registration === null) return null;
  const ordered = [...events].sort((a, b) => a.seq - b.seq || a.ts - b.ts);

  const tasks = new Map<string, Task>();
  const candidates: { ts: number; view: CandidateView }[] = [];
  const checkpoints: { seq: number; hash: string; taskId: string | null; source: string }[] = [];
  const taskEnds = new Map<string, number>();
  const swaps: { ts: number; ms: number }[] = [];
  const executions = new Map<string, ReviewExecution>();
  const findings: { seq: number; view: FindingView }[] = [];

  for (const event of ordered) {
    switch (event.type) {
      case "task.created":
      case "task.state_changed": {
        const task = (event.payload["task"] as Task | undefined);
        if (task === undefined) break;
        tasks.set(task.id, task);
        if (TERMINAL.has(task.state)) taskEnds.set(task.id, event.ts);
        else taskEnds.delete(task.id);
        break;
      }
      case "candidate.created":
      case "candidate.gated": {
        const candidate = (event.payload["candidate"] as CandidateView | undefined);
        if (candidate !== undefined) candidates.push({ ts: event.ts, view: candidate });
        break;
      }
      case "checkpoint.created": {
        const checkpoint = (event.payload["checkpoint"] as { commitHash: string; taskId: string | null; source: string } | undefined);
        if (checkpoint !== undefined) checkpoints.push({ seq: event.seq, hash: checkpoint.commitHash, taskId: checkpoint.taskId, source: checkpoint.source });
        break;
      }
      case "local.model_swap": {
        const ms = event.payload["ms"];
        if (typeof ms === "number") swaps.push({ ts: event.ts, ms });
        break;
      }
      case "review.finished": {
        const execution = (event.payload["execution"] as ReviewExecution | undefined);
        if (execution?.completed === true) executions.set(execution.id, execution);
        break;
      }
      case "finding.raised": {
        const finding = (event.payload["finding"] as FindingView | undefined);
        if (finding !== undefined) findings.push({ seq: event.seq, view: finding });
        break;
      }
      default:
        break;
    }
  }

  const byCard = new Map<string, Task>();
  const cardOfTask = new Map<string, string>();
  for (const task of tasks.values()) {
    if (task.cardId === undefined) continue;
    byCard.set(task.cardId, task);
    cardOfTask.set(task.id, task.cardId);
  }

  return registration.cards.map((card): CardLedgerRow => {
    const task = byCard.get(card.id);
    if (task === undefined) {
      return { card: card.id, title: card.title, result: "waiting", state: "UNPLANNED", commit: null, minutes: null, swapSeconds: 0, reviewIndependence: null, rejectedBy: null, note: "" };
    }
    const own = candidates.filter((entry) => entry.view.taskId === task.id);
    const start = own[0]?.ts ?? null;
    const end = taskEnds.get(task.id) ?? (start === null ? null : now);
    const integration = [...checkpoints].reverse().find((checkpoint) => checkpoint.taskId === task.id && checkpoint.source === "integration");
    const commit = integration?.hash ?? null;

    // Reviews cover a card at its own checkpoint, or at the first later one that was reviewed
    // (a later checkpoint's review reads the whole diff from the baseline, this card's included).
    const reviewed = integration === undefined ? [] : checkpoints.filter((checkpoint) => checkpoint.seq >= integration.seq);
    const coveringHash = reviewed.find((checkpoint) => [...executions.values()].some((execution) => execution.checkpointHash === checkpoint.hash))?.hash ?? null;
    const covering = coveringHash === null ? [] : [...executions.values()].filter((execution) => execution.checkpointHash === coveringHash);
    // A finding is this card's when it was raised on the card's own checkpoint, or cites a file the
    // card was allowed to change; a later checkpoint's review also reads the other cards' diffs.
    const ownFinding = (entry: { view: FindingView }): boolean =>
      entry.view.checkpointHash === commit ||
      (entry.view.evidence ?? []).some((item) => item.path !== undefined && matchesAnyGlob(item.path, card.files));
    const candidatesFindings = coveringHash === null ? [] : findings.filter((entry) => entry.view.checkpointHash === coveringHash && ownFinding(entry));
    const reviewFinding = candidatesFindings.find((entry) => entry.view.blocking) ?? candidatesFindings[0];

    const failedGate = own
      .flatMap((entry) => (entry.view.gateReport?.failures ?? []).map((failure) => ({ model: entry.view.model, failure })))
      .at(0);
    const rejectedBy = reviewFinding !== undefined
      ? { by: reviewFinding.view.reportedBy.model === undefined ? "reviewer" : `${reviewFinding.view.reportedBy.model.provider}:${reviewFinding.view.reportedBy.model.model}`, first: reviewFinding.view.claim }
      : failedGate !== undefined && task.state !== "INTEGRATED"
        ? { by: "gate", first: `${failedGate.failure.reason}: ${failedGate.failure.detail}` }
        : null;

    const blockerCard = task.state === "CANCELLED"
      ? task.dependsOn.map((dependency) => cardOfTask.get(dependency)).find((dependency) => {
          const state = dependency === undefined ? undefined : byCard.get(dependency)?.state;
          return state === "BLOCKED" || state === "REJECTED" || state === "CANCELLED";
        })
      : undefined;
    return {
      card: card.id,
      title: card.title,
      result: resultOf(task.state),
      state: task.state,
      commit: commit === null ? null : commit.slice(0, 8),
      minutes: start === null || end === null ? null : Math.max(0, Math.round(((end - start) / 60_000) * 10) / 10),
      swapSeconds: start === null || end === null ? 0 : Math.round(swaps.filter((swap) => swap.ts >= start && swap.ts <= end).reduce((sum, swap) => sum + swap.ms, 0) / 100) / 10,
      reviewIndependence: covering.length === 0 ? null : reviewIndependenceOf(covering),
      rejectedBy,
      note: blockerCard === undefined ? (task.state === "BLOCKED" ? `blocked after ${String(task.attempts)} attempt(s)` : "") : `skipped: ${blockerCard} did not pass`,
    };
  });
}

function resultOf(state: TaskState): CardResult {
  switch (state) {
    case "INTEGRATED":
      return "accepted";
    case "SATISFIED":
      return "satisfied";
    case "BLOCKED":
      return "failed";
    case "REJECTED":
    case "INTEGRATION_FAILED":
      return "rejected";
    case "CANCELLED":
      return "skipped";
    case "PENDING":
    case "READY":
      return "waiting";
    case "RUNNING":
    case "GATED":
    case "SELECTED":
    case "INTEGRATING":
    case "NEEDS_SPLIT":
    case "SPLIT":
      return "running";
  }
}

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/** One line per card, the same columns everywhere the ledger is shown. */
export function renderCardLedger(rows: readonly CardLedgerRow[]): string[] {
  return rows.map((row) => {
    const parts = [
      row.card.padEnd(5),
      row.result.padEnd(9),
      (row.commit ?? "-").padEnd(8),
      `${row.minutes === null ? "-" : String(row.minutes)} min`.padEnd(9),
      `swap ${String(row.swapSeconds)}s`.padEnd(10),
      (row.reviewIndependence ?? "-").padEnd(19),
      row.rejectedBy === null ? "" : `rejected by ${row.rejectedBy.by}: ${clip(row.rejectedBy.first, 70)}`,
      row.note,
    ];
    return parts.join(" ").trimEnd();
  });
}
