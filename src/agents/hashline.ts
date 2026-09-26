import { createHash } from "node:crypto";
import { PolishError } from "../shared/errors.js";

/**
 * Hashline edits: `read` shows each line as `N:hh|text`, where `hh` is a short hash of the line's
 * text, and `edit` names lines by those anchors instead of retyping them. A worker never has to
 * reproduce whitespace exactly, and an edit against a line that changed since it was read is
 * refused before anything is written. The format follows oh-my-pi's `crates/pi-edit` (MIT); the
 * code is Polish's own.
 */

export interface HashlineEdit {
  op: "replace" | "insert_after" | "delete";
  /** Anchor `N:hh` of the first line; for insert_after, `0` inserts before line 1. */
  start: string;
  /** Anchor of the last line of a replace or delete range; the start line when absent. */
  end?: string;
  /** Lines that replace the range or are inserted; not used by delete. */
  lines?: string[];
}

const ANCHOR = /^(\d+):([0-9a-z]{2})$/;

export function lineHash(text: string): string {
  return createHash("sha1").update(text.replace(/\s+$/, "")).digest("hex").slice(0, 2);
}

export function anchorOf(line: number, text: string): string {
  return `${String(line)}:${lineHash(text)}`;
}

/** `lines[start-1..end-1]` rendered as `N:hh|text`, one per line. */
export function renderAnchored(lines: readonly string[], start: number, end: number): string {
  const out: string[] = [];
  for (let line = start; line <= end; line += 1) out.push(`${anchorOf(line, lines[line - 1] ?? "")}|${lines[line - 1] ?? ""}`);
  return out.join("\n");
}

export function parseEdits(value: unknown): HashlineEdit[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid("edits must be a non-empty array");
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) throw invalid(`edits[${String(index)}] must be an object`);
    const item = raw as Record<string, unknown>;
    const op = item["op"];
    if (op !== "replace" && op !== "insert_after" && op !== "delete") {
      throw invalid(`edits[${String(index)}].op must be replace, insert_after or delete`);
    }
    const start = item["start"];
    if (typeof start !== "string") throw invalid(`edits[${String(index)}].start must be an anchor like "12:a3"`);
    const end = item["end"];
    if (end !== undefined && typeof end !== "string") throw invalid(`edits[${String(index)}].end must be an anchor`);
    const lines = item["lines"];
    if (op !== "delete" && (!Array.isArray(lines) || !lines.every((line) => typeof line === "string"))) {
      throw invalid(`edits[${String(index)}].lines must be an array of strings (use [] to empty a range)`);
    }
    return { op, start, ...(end === undefined ? {} : { end }), ...(op === "delete" ? {} : { lines: lines as string[] }) };
  });
}

interface Resolved {
  /** First line replaced (1-based); for an insert, the line after which text goes (0 = top). */
  from: number;
  /** Last line replaced; `from - 1` for an insert. */
  to: number;
  lines: string[];
}

/**
 * Apply `edits` to `before`, all anchored against `before` itself. Throws on a stale anchor, an
 * overlap, or an edit that changes nothing; nothing is partially applied.
 */
export function applyHashlineEdits(before: string, edits: readonly HashlineEdit[]): { after: string; changed: { from: number; to: number } } {
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const endsWithNewline = before.endsWith("\n");
  const lines = before === "" ? [] : before.replace(/\r?\n$/, "").split(/\r?\n/);
  const resolved = edits.map((edit) => resolveEdit(edit, lines)).sort((a, b) => a.from - b.from);
  for (let i = 1; i < resolved.length; i += 1) {
    const previous = resolved[i - 1];
    const current = resolved[i];
    if (previous !== undefined && current !== undefined && current.from <= previous.to) {
      throw new PolishError("CONFLICT", `edits overlap at line ${String(current.from)}; send one edit per range`);
    }
  }
  const next = [...lines];
  for (const edit of [...resolved].reverse()) next.splice(edit.from - 1, removedBy(edit), ...edit.lines);
  const after = next.length === 0 ? "" : `${next.join(eol)}${endsWithNewline || before === "" ? eol : ""}`;
  let offset = 0;
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const edit of resolved) {
    const start = edit.from + offset;
    from = Math.min(from, start);
    to = Math.max(to, start + edit.lines.length - 1, start);
    offset += edit.lines.length - removedBy(edit);
  }
  return { after, changed: { from: Math.max(1, Math.min(from, next.length)), to: Math.min(Math.max(to, 1), Math.max(next.length, 1)) } };
}

function removedBy(edit: Resolved): number {
  return edit.to < edit.from ? 0 : edit.to - edit.from + 1;
}

function resolveEdit(edit: HashlineEdit, lines: readonly string[]): Resolved {
  if (edit.op === "insert_after") {
    const at = edit.start === "0" ? 0 : checkAnchor(edit.start, lines);
    return { from: at + 1, to: at, lines: edit.lines ?? [] };
  }
  const from = checkAnchor(edit.start, lines);
  const to = edit.end === undefined ? from : checkAnchor(edit.end, lines);
  if (to < from) throw invalid(`end ${edit.end ?? ""} is before start ${edit.start}`);
  return { from, to, lines: edit.op === "delete" ? [] : edit.lines ?? [] };
}

function checkAnchor(anchor: string, lines: readonly string[]): number {
  const match = ANCHOR.exec(anchor.trim());
  if (match === null) throw invalid(`"${anchor}" is not an anchor; copy it from read output, like "12:a3"`);
  const line = Number(match[1]);
  if (line < 1 || line > lines.length) {
    throw new PolishError("CONFLICT", `edit rejected: line ${String(line)} does not exist (the file has ${String(lines.length)} lines); read it again`);
  }
  const actual = lineHash(lines[line - 1] ?? "");
  if (actual !== match[2]) {
    throw new PolishError(
      "CONFLICT",
      `edit rejected: line ${String(line)} changed since it was read (anchor ${anchor}, now ${anchorOf(line, lines[line - 1] ?? "")}); ` +
        "read the file again and use the new anchors",
    );
  }
  return line;
}

function invalid(message: string): PolishError {
  return new PolishError("INVALID_ARGUMENT", message);
}

const NOOP_HARD_LIMIT = 3;

/** Counts byte-identical no-op edits per path, so the third one is answered with a stop. */
export class NoopTracker {
  private readonly counts = new Map<string, { payload: string; count: number }>();

  /** Record a no-op and return the refusal to send back. */
  refuse(path: string, payload: string): PolishError {
    const prior = this.counts.get(path);
    const count = prior?.payload === payload ? prior.count + 1 : 1;
    this.counts.set(path, { payload, count });
    if (count >= NOOP_HARD_LIMIT) {
      return new PolishError(
        "CONFLICT",
        `STOP. Edits to ${path} have been a byte-identical no-op ${String(count)} times. The file already contains this text. ` +
          "Do not send this edit again: read the file, decide what actually has to differ, or finish if nothing does.",
      );
    }
    return new PolishError(
      "CONFLICT",
      `edit to ${path} produced no change: the new lines are identical to the lines they replace. Nothing was written.`,
    );
  }

  reset(path: string): void {
    this.counts.delete(path);
  }
}
