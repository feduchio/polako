import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Per-model notes files for a model, most specific first. A `[cards.modelNotes]` key matches a
 * model by its exact key, by the start of its key or of the key's last path segment (`ornith`
 * matches `ornith-ai/ornith-1.5-35b-a3b`), or by its lineage family (`qwen`). Each file once.
 */
export function modelNotesFor(notes: Readonly<Record<string, string>>, modelKey: string, lineage: string): string[] {
  const lower = modelKey.toLowerCase();
  const tail = lower.slice(lower.lastIndexOf("/") + 1);
  const exact: string[] = [];
  const prefix: string[] = [];
  const family: string[] = [];
  for (const [key, path] of Object.entries(notes)) {
    const k = key.toLowerCase();
    if (k === lower) exact.push(path);
    else if (k === lineage.toLowerCase()) family.push(path);
    else if (lower.startsWith(k) || tail.startsWith(k)) prefix.push(path);
  }
  return [...new Set([...exact, ...prefix, ...family])];
}

/** Read a guidance file relative to the project; a missing file is skipped, not an error. */
export function readGuidanceFile(projectPath: string, path: string): string | null {
  const full = isAbsolute(path) ? path : resolve(projectPath, path);
  if (!existsSync(full)) return null;
  const text = readFileSync(full, "utf8").trim();
  return text === "" ? null : text;
}

/** The brief plus every matching notes file, as one block for the worker's instruction. */
export function composeGuidance(brief: string, notes: readonly string[]): string {
  return [brief.trim(), ...notes.map((note) => note.trim())].filter((part) => part !== "").join("\n\n");
}
