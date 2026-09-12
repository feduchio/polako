import type { ChatMessage } from "../broker/types.js";
import { estimateTokens } from "../context/types.js";
import type { AgentTurn } from "./types.js";

/** Longest rendering of a path inside the digest; longer ones keep their tail. */
const PATH_CHARS = 80;
/** Longest rendering of an error message or a failing command's output. */
const TAIL_CHARS = 200;

/**
 * Digest budget, derived rather than constant. The pack and the digest are both resent every
 * turn, so an oversized digest buys fewer turns than the quadratic history it replaces: measured
 * on this tree the break-even is 851 tokens at the largest pack the worker cap allows. The 400
 * ceiling sits 2.1x below that, which is the margin that holds if the measured per-turn growth of
 * 203 tokens is off by a third in either direction.
 */
export function loopDigestCap(effectiveTaskBudget: number): number {
  return Math.min(Math.max(Math.floor(effectiveTaskBudget / 80), 200), 400);
}

/**
 * Order in which entries survive a binding cap. Changed paths outlive everything because a worker
 * that forgets what it edited cannot finish; its own prose goes first because two of the six
 * measured transcripts had none at all.
 */
const PRIORITY = {
  changed: 0,
  failedCommand: 1,
  command: 2,
  toolCall: 3,
  error: 3,
  note: 4,
} as const;

type Section = keyof typeof PRIORITY;

interface DigestEntry {
  readonly section: Section;
  readonly priority: number;
  /**
   * Position of the call in the loop, counted across turns rather than by turn. A turn can make
   * several calls, so a turn number cannot say which of two failures in one turn came last.
   */
  readonly seq: number;
  readonly text: string;
}

const SECTION_LABEL: Record<Section, string> = {
  changed: "Changed",
  failedCommand: "Command failed",
  command: "Commands",
  toolCall: "Tools",
  error: "Errors",
  note: "Notes",
};

const SECTION_ORDER: readonly Section[] = ["changed", "failedCommand", "command", "toolCall", "error", "note"];

/**
 * What happened before the most recent turn, as an inventory rather than a summary. The reasoning
 * trace is not reconstructed: `note` carries only the head of what the worker said, and the detail
 * it needs to act lives in the most recent turn, which the window sends verbatim.
 */
export function buildLoopDigest(history: readonly AgentTurn[], cap: number): string {
  if (history.length === 0) return "";
  const entries = collectEntries(history);
  // An entry whose own rendering exceeds the cap can only be evicted whole: arguments such as an
  // argv or a search query have no shortened form, unlike paths and output tails.
  const survivable = entries.filter((entry) => estimateTokens(entry.text) <= cap);
  const ordered = [...survivable].sort(
    (a, b) => a.priority - b.priority || b.seq - a.seq || a.text.localeCompare(b.text),
  );

  for (let kept = ordered.length; kept > 0; kept -= 1) {
    const text = render(ordered.slice(0, kept), history.length);
    if (estimateTokens(text) <= cap) return text;
  }
  return "";
}

function render(entries: readonly DigestEntry[], turns: number): string {
  const lines = [`## Earlier in this loop (turns 1-${turns})`];
  for (const section of SECTION_ORDER) {
    const texts = entries.filter((entry) => entry.section === section).map((entry) => entry.text);
    if (texts.length === 0) continue;
    lines.push(`${SECTION_LABEL[section]}: ${texts.join("; ")}`);
  }
  return lines.join("\n");
}

function collectEntries(history: readonly AgentTurn[]): DigestEntry[] {
  const entries: DigestEntry[] = [];
  const errorCounts = new Map<string, { seq: number; count: number }>();
  const seenChanged = new Set<string>();
  const seenToolCall = new Set<string>();
  let failedCommandSeq = -1;
  let seq = 0;

  for (const turn of history) {
    if (turn.assistant.content.trim() !== "") {
      entries.push({ section: "note", priority: PRIORITY.note, seq: seq += 1, text: head(turn.assistant.content.trim()) });
    }
    const args = new Map((turn.assistant.toolCalls ?? []).map((call) => [call.id, call.arguments]));
    for (const result of turn.toolResults) {
      seq += 1;
      const parsed = parseArgs(args.get(result.toolCallId));
      if (!result.ok) {
        // A failure carries its target too: "read failed" tells a worker nothing about which path
        // it may not read. The output is absent on failure, so the identity comes from the
        // arguments alone.
        const identity = identifyingArgument(result.name, null, parsed);
        const label = identity === "" ? result.name : `${result.name} ${identity}`;
        const key = `${label}: ${tail(result.error ?? "failed")}`;
        const prior = errorCounts.get(key);
        errorCounts.set(key, { seq, count: (prior?.count ?? 0) + 1 });
        continue;
      }
      if (result.name === "write" || result.name === "apply_patch") {
        const tag = result.name === "write" ? "write" : "patch";
        const key = `${shortPath(pathOf(result.output, parsed))} (${tag})`;
        if (!seenChanged.has(key)) {
          seenChanged.add(key);
          entries.push({ section: "changed", priority: PRIORITY.changed, seq, text: key });
        }
        continue;
      }
      if (result.name === "run_command") {
        const argv = stringField(parsed, "argv") ?? "run_command";
        const exitCode = numberField(result.output, "exitCode");
        const failed = exitCode !== null && exitCode !== 0;
        if (failed && seq > failedCommandSeq) failedCommandSeq = seq;
        entries.push({
          section: failed ? "failedCommand" : "command",
          priority: failed ? PRIORITY.failedCommand : PRIORITY.command,
          seq,
          text: failed
            ? `${argv} -> exit ${String(exitCode)}: ${tail(outputOf(result.output))}`
            : `${argv} -> exit ${exitCode === null ? "?" : String(exitCode)}`,
        });
        continue;
      }
      const identity = identifyingArgument(result.name, result.output, parsed);
      const key = `${result.name} ${identity}`;
      if (!seenToolCall.has(key)) {
        seenToolCall.add(key);
        entries.push({ section: "toolCall", priority: PRIORITY.toolCall, seq, text: key });
      }
    }
  }

  // Only the newest failure keeps its output; older ones fall back to their exit code, so a long
  // run of failures cannot crowd out everything else.
  // Annotated rather than asserted: the annotation types the literal below, which tsc needs and
  // which lint does not flag as a redundant assertion.
  const demoted: DigestEntry[] = entries.map((entry) =>
    entry.section === "failedCommand" && entry.seq !== failedCommandSeq
      ? { ...entry, section: "command", priority: PRIORITY.command, text: entry.text.replace(/: [\s\S]*$/, "") }
      : entry,
  );

  for (const [key, { seq: at, count }] of errorCounts) {
    demoted.push({
      section: "error",
      priority: PRIORITY.error,
      seq: at,
      text: count > 1 ? `${key} (x${String(count)})` : key,
    });
  }
  return demoted;
}

/**
 * Which argument names the call. `read` and `list` are a path, `search` and `request_context` a
 * query, `repo_intel` its action: without these a worker cannot tell that it already searched for
 * a symbol and found nothing, and searches again.
 */
function identifyingArgument(name: string, output: unknown, args: Record<string, unknown>): string {
  switch (name) {
    case "read":
    case "list":
    case "write":
    case "apply_patch":
      return shortPath(pathOf(output, args));
    case "run_command":
      return stringField(args, "argv") ?? "";
    case "search":
    case "request_context":
      return quote(stringField(args, "query") ?? "");
    case "repo_intel": {
      const action = stringField(args, "action") ?? "?";
      const query = stringField(args, "query");
      return query === null || query === "" ? action : `${action} ${quote(query)}`;
    }
    default:
      return "";
  }
}

function parseArgs(encoded: string | undefined): Record<string, unknown> {
  if (encoded === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(encoded);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringField(source: unknown, key: string): string | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(" ");
  return null;
}

function numberField(source: unknown, key: string): number | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

function pathOf(output: unknown, args: Record<string, unknown>): string {
  return stringField(output, "path") ?? stringField(args, "path") ?? ".";
}

function outputOf(output: unknown): string {
  const stderr = stringField(output, "stderr") ?? "";
  const stdout = stringField(output, "stdout") ?? "";
  const combined = stderr.trim() === "" ? stdout : stderr;
  return combined.trim() === "" ? "(no output)" : combined;
}

function shortPath(path: string): string {
  return path.length <= PATH_CHARS ? path : `\u2026${path.slice(-PATH_CHARS)}`;
}

/** Failures are diagnosed from the end of their output, so the tail is what is kept. */
function tail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= TAIL_CHARS ? flat : `\u2026${flat.slice(-TAIL_CHARS)}`;
}

/** Intent leads a worker's prose, so its head is what is kept. */
function head(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= TAIL_CHARS ? flat : `${flat.slice(0, TAIL_CHARS)}\u2026`;
}

function quote(text: string): string {
  return `"${text}"`;
}

/**
 * The messages one request carries: the fixed prompt, a bounded digest of everything before the
 * most recent turn, and that turn verbatim.
 *
 * The verbatim tail is sliced out of the archive rather than rebuilt, which is what keeps the
 * assistant message and its tool results paired: `toOpenAIMessage` maps a tool message to
 * `tool_call_id`, and an unanswered id is a hard rejection from every OpenAI-compatible provider.
 */
export function buildWireWindow(input: {
  readonly archive: readonly ChatMessage[];
  readonly turns: readonly AgentTurn[];
  readonly digestCap: number;
}): ChatMessage[] {
  const prefixEnd = input.archive.findIndex((message) => message.role === "user");
  const prefix = prefixEnd === -1 ? [...input.archive] : input.archive.slice(0, prefixEnd + 1);
  if (input.turns.length === 0) return prefix;

  let lastAssistant = -1;
  for (let i = input.archive.length - 1; i >= 0; i -= 1) {
    if (input.archive[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant === -1) return prefix;

  const digest = buildLoopDigest(input.turns.slice(0, -1), input.digestCap);
  return [
    ...prefix,
    ...(digest === "" ? [] : [{ role: "user" as const, content: digest }]),
    ...input.archive.slice(lastAssistant),
  ];
}
