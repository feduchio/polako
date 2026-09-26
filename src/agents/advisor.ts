import type { AdvisorLevel, AdvisorNote, AgentTurn } from "./types.js";

/**
 * A second model reading each worker turn and, rarely, saying something: a nit, a concern, or a
 * blocker. Off by default; the live tier decides whether it pays for itself (after oh-my-pi's
 * advisor). It advises only — it runs no tool and decides nothing.
 */
export type { Advise, AdvisorLevel, AdvisorNote } from "./types.js";

export const ADVISOR_SYSTEM_PROMPT =
  "You watch a coding agent work on one task. After each of its turns you see what it called and what came back. " +
  'Answer JSON only: {"note": null} when there is nothing worth saying, which is most turns, or ' +
  '{"note": {"level": "nit" | "concern" | "blocker", "text": "..."}}. A blocker is a concrete mistake that will make the ' +
  "task fail or its result wrong (writing tests the project's runner cannot run, editing the wrong file, finishing " +
  "without running the check the task names). A concern is a likely mistake. A nit is minor. Name the evidence in one or two sentences.";

const LEVELS: ReadonlySet<string> = new Set(["nit", "concern", "blocker"]);
const CONTENT_FREE = /^(?:lgtm|looks good|ok(?:ay)?|fine|none|nothing|no (?:issues?|concerns?))[.!]?$/i;
const RESULT_CHARS = 240;

export function parseAdvisorReply(text: string): AdvisorNote | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const note = (parsed as { note?: unknown } | null)?.note;
  if (typeof note !== "object" || note === null) return null;
  const { level, text: body } = note as { level?: unknown; text?: unknown };
  if (typeof level !== "string" || !LEVELS.has(level) || typeof body !== "string" || body.trim() === "") return null;
  return { level: level as AdvisorLevel, text: body.trim() };
}

/** What the advisor is shown of one turn: each call with its arguments and the head of its result. */
export function turnSummary(turn: AgentTurn): string {
  const calls = turn.assistant.toolCalls ?? [];
  const lines = calls.map((call, index) => {
    const result = turn.toolResults[index];
    const outcome = result === undefined ? "(no result)" : JSON.stringify(result).slice(0, RESULT_CHARS);
    return `${call.name} ${call.arguments.slice(0, RESULT_CHARS)} -> ${outcome}`;
  });
  return `Turn ${String(turn.turn)}:\n${lines.join("\n") || turn.assistant.content.slice(0, RESULT_CHARS)}`;
}

/** Drops content-free and repeated notes and caps them per attempt; blockers are never capped. */
export class AdvisorNotes {
  private readonly seen = new Set<string>();
  private spent = 0;

  constructor(private readonly budget = 4) {}

  /** The message to put before the worker's next turn, or null to say nothing. */
  accept(note: AdvisorNote | null): string | null {
    if (note === null || CONTENT_FREE.test(note.text)) return null;
    const key = note.text.toLowerCase().replace(/\s+/g, " ");
    if (this.seen.has(key)) return null;
    if (note.level !== "blocker" && this.spent >= this.budget) return null;
    this.seen.add(key);
    if (note.level !== "blocker") this.spent += 1;
    return `[advisor ${note.level}] ${note.text}`;
  }
}
