import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { cardsDirectory, loadCards, looksLikeCards, validateCards, type Card } from "../cards/index.js";
import { PolishError } from "../shared/errors.js";

export interface RunTarget {
  /** Project path as typed, or null to derive it (from the cards' repository, else the cwd). */
  project: string | null;
  /** Card specs (file, directory or glob); empty for a mission run. */
  cardSpecs: string[];
  mission: string;
}

/**
 * What `polako run` was asked to run. `--mission` always means a mission. Otherwise positional
 * arguments that are task cards (an existing `.md` file, a directory of cards, a glob that matches
 * `.md` files) make it a card run, optionally after a project path; anything else is the old
 * `[project] [mission words]`. A git repository is a project, never a card directory.
 */
export function resolveRunTarget(
  positional: readonly string[],
  mission: string | undefined,
  cwd = process.cwd(),
  looks: (spec: string, cwd: string) => boolean = looksLikeCards,
): RunTarget {
  if (mission !== undefined) {
    if (positional.slice(1).some((arg) => looks(arg, cwd))) {
      throw new PolishError("CONFIG_ERROR", "use either --mission or task cards, not both");
    }
    return { project: positional[0] ?? null, cardSpecs: [], mission };
  }
  if (positional.length === 0) return { project: null, cardSpecs: [], mission: "" };
  if (positional.every((arg) => looks(arg, cwd))) return { project: null, cardSpecs: [...positional], mission: "" };
  const [first, ...rest] = positional;
  if (first !== undefined && rest.length > 0 && rest.every((arg) => looks(arg, cwd))) {
    return { project: first, cardSpecs: rest, mission: "" };
  }
  return { project: first ?? null, cardSpecs: [], mission: rest.join(" ") };
}

/** The project a card run belongs to: the git repository the first card lives in, else the cwd. */
export function projectForCards(spec: string, cwd = process.cwd()): string {
  const dir = cardsDirectory(spec, cwd);
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return cwd;
  }
}

export function loadCardSpecs(specs: readonly string[], cwd = process.cwd()): Card[] {
  const cards = specs.flatMap((spec) => loadCards(spec, cwd));
  validateCards(cards);
  return cards;
}

/** `--only A,B` → `["A","B"]`; also accepts spaces. */
export function parseOnly(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(/[,\s]+/).map((id) => id.trim()).filter((id) => id !== "");
  if (ids.length === 0) throw new PolishError("CONFIG_ERROR", "--only needs at least one card id");
  return ids;
}

/** The brief named by `--brief`, read now: its text is frozen into the run. */
export function readBrief(path: string | undefined, cwd = process.cwd()): { brief: string; briefSource: string } | undefined {
  if (path === undefined) return undefined;
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  if (!existsSync(full)) throw new PolishError("NOT_FOUND", `--brief file not found: ${path}`);
  return { brief: readFileSync(full, "utf8").trim(), briefSource: path };
}
