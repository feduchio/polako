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
  /**
   * A failing command's output, carried apart from `text` so demotion can drop it by setting this
   * to `null`. Re-parsing the rendered line cannot: an argv containing `: ` is indistinguishable
   * from the separator, and the exit code goes with the tail.
   */
  readonly tail: string | null;
}

function renderEntry(entry: DigestEntry): string {
  return entry.tail === null ? entry.text : `${entry.text}: ${entry.tail}`;
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
 * A call's outcome is carried by which section it lands in rather than by a word appended to every
 * line: a successful call renders under `Tools`, a failed one under `Errors` with its message. The
 * section label costs nothing per entry, which matters at a 400-token cap.
 */

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
  const survivable = entries.filter((entry) => estimateTokens(renderEntry(entry)) <= cap);
  const ordered = [...survivable].sort(
    (a, b) => a.priority - b.priority || b.seq - a.seq || renderEntry(a).localeCompare(renderEntry(b)),
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
    const texts = entries.filter((entry) => entry.section === section).map(renderEntry);
    if (texts.length === 0) continue;
    lines.push(`${SECTION_LABEL[section]}: ${texts.join("; ")}`);
  }
  return lines.join("\n");
}

function collectEntries(history: readonly AgentTurn[]): DigestEntry[] {
  const entries: DigestEntry[] = [];
  const errorCounts = new Map<string, { seq: number; count: number }>();
  const repeatedResults = new Map<string, { seq: number; count: number; text: string }>();
  const seenChanged = new Set<string>();
  const seenToolCall = new Set<string>();
  let failedCommandSeq = -1;
  let seq = 0;

  for (const turn of history) {
    if (turn.assistant.content.trim() !== "") {
      entries.push({ section: "note", priority: PRIORITY.note, seq: seq += 1, text: head(turn.assistant.content.trim()), tail: null });
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
      if (result.name === "write" || result.name === "edit") {
        const tag = result.name === "write" ? "write" : "edit";
        const key = `${shortPath(pathOf(result.output, parsed))} (${tag})`;
        if (!seenChanged.has(key)) {
          seenChanged.add(key);
          entries.push({ section: "changed", priority: PRIORITY.changed, seq, text: key, tail: null });
        }
        continue;
      }
      if (result.name === "search" || result.name === "list" || result.name === "read") {
        const identity = identifyingArgument(result.name, result.output, parsed);
        const summary = boundedResult(result.name, result.output);
        const text = summary === ""
          ? `${result.name} ${identity}`.trim()
          : `${result.name} ${identity} ${summary}`.trim();
        const prior = repeatedResults.get(text);
        repeatedResults.set(text, { seq, count: (prior?.count ?? 0) + 1, text });
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
          text: `${argv} -> exit ${exitCode === null ? "?" : String(exitCode)}`,
          tail: failed ? tail(outputOf(result.output)) : null,
        });
        continue;
      }
      const identity = identifyingArgument(result.name, result.output, parsed);
      const key = `${result.name} ${identity}`;
      if (!seenToolCall.has(key)) {
        seenToolCall.add(key);
        entries.push({ section: "toolCall", priority: PRIORITY.toolCall, seq, text: key, tail: null });
      }
    }
  }

  // Only the newest failure keeps its output; older ones fall back to their exit code, so a long
  // run of failures cannot crowd out everything else.
  // Annotated rather than asserted: the annotation types the literal below, which tsc needs and
  // which lint does not flag as a redundant assertion.
  const demoted: DigestEntry[] = entries.map((entry) =>
    entry.section === "failedCommand" && entry.seq !== failedCommandSeq
      ? { ...entry, section: "command", priority: PRIORITY.command, tail: null }
      : entry,
  );

  for (const { seq: at, count, text } of repeatedResults.values()) {
    demoted.push({
      section: "toolCall",
      priority: PRIORITY.toolCall,
      seq: at,
      text: count > 1 ? `${text} (x${String(count)})` : text,
      tail: null,
    });
  }

  for (const [key, { seq: at, count }] of errorCounts) {
    demoted.push({
      section: "error",
      priority: PRIORITY.error,
      seq: at,
      text: count > 1 ? `${key} (x${String(count)})` : key,
      tail: null,
    });
  }
  return demoted;
}

/**
 * What the call returned, in a form that fits one digest line. A search that found nothing has to
 * say so: the previous digest recorded the query and dropped the empty result, and the worker
 * searched again.
 */
function boundedResult(name: string, output: unknown): string {
  if (name === "search") {
    const count = numberField(output, "matchCount");
    return count === null ? "" : `(${String(count)} matches)`;
  }
  if (name === "list") {
    const count = numberField(output, "entryCount");
    return count === null ? "" : `(${String(count)} entries)`;
  }
  if (name === "read") {
    const start = numberField(output, "startLine");
    const end = numberField(output, "endLine");
    if (start === null || end === null) return "";
    const total = numberField(output, "totalLines");
    return total === null || (start === 1 && end === total)
      ? `(lines ${String(start)}-${String(end)})`
      : `(lines ${String(start)}-${String(end)} of ${String(total)})`;
  }
  return "";
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
    case "edit":
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
  const content = stringField(output, "content");
  if (content !== null) {
    const marker = content.indexOf("[stderr]\n");
    const stderr = marker === -1 ? "" : content.slice(marker + "[stderr]\n".length);
    const stdout = marker === -1 ? content : content.slice(0, marker);
    const shown = stderr.trim() === "" ? stdout : stderr;
    const more = numberField(output, "nextStartLine");
    const total = numberField(output, "totalLines");
    const note = more === null || total === null ? "" : ` (first ${String(more - 1)} of ${String(total)} lines)`;
    return shown.trim() === "" ? "(no output)" : `${shown}${note}`;
  }
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
 * The messages one request carries: the fixed prompt, the most recent turns verbatim while they fit
 * in `verbatimTokens`, and a bounded digest of the turns before them. The newest turn is sent
 * whole whatever its size.
 *
 * Only the newest turn used to be verbatim. A worker then saw what it had read one turn ago and
 * nothing before, so reading two files became reading them in turn forever:
 * run_01m3dpv223r4cdbcx7ydr4 alternated `read src/add.mjs` and `read tests/add.test.mjs` from
 * turn 27 until its budget ran out, on requests of about 2,400 tokens to a 128k-context model.
 *
 * The verbatim tail is sliced out of the archive rather than rebuilt, which is what keeps the
 * assistant message and its tool results paired: `toOpenAIMessage` maps a tool message to
 * `tool_call_id`, and an unanswered id is a hard rejection from every OpenAI-compatible provider.
 */
export function buildWireWindow(input: {
  readonly archive: readonly ChatMessage[];
  readonly turns: readonly AgentTurn[];
  readonly digestCap: number;
  readonly verbatimTokens: number;
}): ChatMessage[] {
  const archive = stubSupersededResults(input.archive);
  const prefixEnd = archive.findIndex((message) => message.role === "user");
  const prefix = prefixEnd === -1 ? [...archive] : archive.slice(0, prefixEnd + 1);
  if (input.turns.length === 0) return prefix;

  const turnStarts: number[] = [];
  archive.forEach((message, index) => {
    if (index > prefixEnd && message.role === "assistant") turnStarts.push(index);
  });
  const newest = turnStarts.at(-1);
  if (newest === undefined) return prefix;

  let start = newest;
  let kept = 1;
  let spent = tokensOf(archive.slice(newest));
  for (let k = turnStarts.length - 2; k >= 0 && kept < input.turns.length; k -= 1) {
    const from = turnStarts[k] ?? start;
    const cost = tokensOf(archive.slice(from, start));
    if (spent + cost > input.verbatimTokens) break;
    spent += cost;
    start = from;
    kept += 1;
  }

  const digest = buildLoopDigest(input.turns.slice(0, input.turns.length - kept), input.digestCap);
  return [
    ...prefix,
    ...(digest === "" ? [] : [{ role: "user" as const, content: digest }]),
    ...archive.slice(start),
  ];
}

/**
 * Tool results a later call has made stale, replaced by a short stub: a `run_command` whose argv
 * runs again later, and a `read` of a file that is read, written or edited again later. The worker
 * acts on the newer result; carrying the old one in full is what spent a SAT attempt's tokens
 * (a 385-line suite output re-sent every turn). Stubs keep the call paired with its result and
 * name the output ref, so nothing becomes unreadable (after oh-my-pi's tool-output pruning).
 */
export function stubSupersededResults(archive: readonly ChatMessage[]): ChatMessage[] {
  const calls = new Map<string, { name: string; key: string | null }>();
  for (const message of archive) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) calls.set(call.id, { name: call.name, key: supersedeKey(call.name, call.arguments) });
  }
  const laterKeys = new Set<string>();
  const out = [...archive];
  for (let index = archive.length - 1; index >= 0; index -= 1) {
    const message = archive[index];
    if (message?.role !== "tool") continue;
    const call = calls.get(message.toolCallId);
    if (call?.key == null) continue;
    const stale = (call.name === "run_command" || call.name === "read") && laterKeys.has(call.key);
    if (stale) out[index] = { ...message, content: stubFor(call.name, message.content) };
    laterKeys.add(call.key);
  }
  return out;
}

function supersedeKey(name: string, rawArgs: string): string | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (name === "run_command") return Array.isArray(args["argv"]) ? `run ${JSON.stringify([args["argv"], args["cwd"] ?? null])}` : null;
  // A read, write or edit of a path all make an earlier read of it stale; paged reads are left alone.
  if ((name === "read" && args["startLine"] === undefined) || name === "write" || name === "edit") {
    return typeof args["path"] === "string" ? `file ${args["path"]}` : null;
  }
  return null;
}

function stubFor(name: string, content: string): string {
  let output: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(content) as { output?: unknown };
    if (typeof parsed.output === "object" && parsed.output !== null) output = parsed.output as Record<string, unknown>;
  } catch {
    // an unparseable result keeps nothing but the stub
  }
  const kept = Object.fromEntries(
    ["path", "argv", "exitCode", "outputRef", "fullOutputRef"].filter((key) => output[key] !== undefined).map((key) => [key, output[key]]),
  );
  const why = name === "run_command"
    ? "superseded: the same command ran again later in this loop; its later result is current"
    : "superseded: this file was read, written or edited again later; use the later result for its content and anchors";
  return JSON.stringify({ ok: true, output: { ...kept, superseded: why } });
}

function tokensOf(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) =>
    sum + estimateTokens(message.content) + (message.role === "assistant" ? estimateTokens(JSON.stringify(message.toolCalls ?? [])) : 0), 0);
}
