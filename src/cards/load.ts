import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PolishError } from "../shared/errors.js";
import { globToRegExp, isGlobPattern } from "./glob.js";
import { parseCard } from "./parse.js";
import type { Card } from "./types.js";

const SKIPPED_NAMES = /^(?:readme|index|_|\.)/i;

/** A card file begins with an `id:` header line. */
function startsLikeCard(path: string): boolean {
  try {
    const head = readFileSync(path, "utf8").split(/\r?\n/).find((line) => line.trim() !== "");
    return head !== undefined && /^id:\s*\S/i.test(head);
  } catch {
    return false;
  }
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function markdownIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => isMarkdown(name) && !SKIPPED_NAMES.test(name))
    .sort()
    .map((name) => join(dir, name));
}

/** Files matching a glob such as `docs/agents/tasks/N0*.md`, found by walking from its static prefix. */
function expandGlob(pattern: string, cwd: string): string[] {
  const absolute = isAbsolute(pattern) ? pattern : join(cwd, pattern);
  const segments = absolute.split("/");
  const firstMeta = segments.findIndex((segment) => isGlobPattern(segment));
  const root = segments.slice(0, Math.max(firstMeta, 1)).join("/") || "/";
  const rule = globToRegExp(absolute);
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(dir, name);
      if (isDirectory(full)) walk(full, depth + 1);
      else if (rule.test(full)) out.push(full);
    }
  };
  walk(root, 0);
  return out.filter(isMarkdown);
}

/**
 * Whether `spec` names task cards rather than a project or free text: an existing `.md` file, a
 * directory without a `.git` that holds card files, or a glob that matches `.md` files.
 */
export function looksLikeCards(spec: string, cwd = process.cwd()): boolean {
  const path = isAbsolute(spec) ? spec : resolve(cwd, spec);
  if (isGlobPattern(spec)) return expandGlob(spec, cwd).length > 0;
  if (!existsSync(path)) return false;
  if (isDirectory(path)) return !existsSync(join(path, ".git")) && markdownIn(path).some(startsLikeCard);
  return isMarkdown(path);
}

/** Read every card a spec names, in a stable order (file name), each tagged with its source path. */
export function loadCards(spec: string, cwd = process.cwd()): Card[] {
  const path = isAbsolute(spec) ? spec : resolve(cwd, spec);
  let files: string[];
  if (isGlobPattern(spec)) files = expandGlob(spec, cwd);
  else if (isDirectory(path)) files = markdownIn(path).filter(startsLikeCard);
  else if (existsSync(path)) files = [path];
  else throw new PolishError("NOT_FOUND", `task cards not found: ${spec}`, { spec });
  if (files.length === 0) throw new PolishError("NOT_FOUND", `no task cards (*.md with an \`id:\` header) in ${spec}`, { spec });
  return files.map((file) => parseCard(readFileSync(file, "utf8"), relative(cwd, file) || basename(file)));
}

/** The directory a card spec lives in; used to find the project when none is named. */
export function cardsDirectory(spec: string, cwd = process.cwd()): string {
  if (isGlobPattern(spec)) {
    const absolute = isAbsolute(spec) ? spec : join(cwd, spec);
    const segments = absolute.split("/");
    const firstMeta = segments.findIndex((segment) => isGlobPattern(segment));
    return segments.slice(0, Math.max(firstMeta, 1)).join("/") || "/";
  }
  const path = isAbsolute(spec) ? spec : resolve(cwd, spec);
  return isDirectory(path) ? path : dirname(path);
}
