import { PolishError } from "../shared/errors.js";
import type { AcceptanceCheck, TaskKind } from "../domain/task.js";
import { CardSchema, type Card, type CardRegistration } from "./types.js";
import { isGlobPattern, normalizePath } from "./glob.js";

/**
 * Everything wrong with a card set, found before any run exists. Unknown dependency ids, duplicate
 * ids and cycles are the errors that would otherwise surface hours into a run as a task that never
 * becomes ready.
 */
export function validateCards(cards: readonly Card[]): void {
  const problems: string[] = [];
  const seen = new Map<string, Card>();
  for (const card of cards) {
    const earlier = seen.get(card.id);
    if (earlier !== undefined) {
      problems.push(`duplicate card id ${card.id} (${earlier.source ?? "?"} and ${card.source ?? "?"})`);
    }
    seen.set(card.id, card);
  }
  for (const card of cards) {
    for (const dependency of card.depends) {
      if (dependency === card.id) problems.push(`card ${card.id} depends on itself`);
      else if (!seen.has(dependency)) problems.push(`card ${card.id} depends on unknown card ${dependency}`);
    }
  }
  if (problems.length === 0) {
    const cycle = findCycle(cards);
    if (cycle !== null) problems.push(`dependency cycle: ${cycle.join(" -> ")}`);
  }
  if (problems.length > 0) {
    throw new PolishError("CONFIG_ERROR", `invalid task cards:\n- ${problems.join("\n- ")}`, { problems });
  }
}

/** The first dependency cycle as `A -> B -> A`, or null. Depth-first, in card order. */
function findCycle(cards: readonly Card[]): string[] | null {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of byId.get(id)?.depends ?? []) {
      const found = visit(dependency);
      if (found !== null) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const card of cards) {
    const found = visit(card.id);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The cards a run will execute. `only` picks a subset; a dependency on a card that was left out is
 * dropped and recorded, on the reading that whoever selects a subset has the rest already in place.
 * Validation runs on the whole set first, so a typo in `--only` or a broken card elsewhere is an
 * error rather than a quietly smaller run.
 */
export function registerCards(cards: readonly Card[], options: { only?: readonly string[]; brief?: string; briefSource?: string | null } = {}): CardRegistration {
  validateCards(cards);
  const only = options.only ?? [];
  const known = new Set(cards.map((card) => card.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new PolishError("CONFIG_ERROR", `--only names unknown card(s): ${unknown.join(", ")}; known: ${[...known].join(", ")}`, { unknown });
  }
  const selected = only.length === 0 ? [...cards] : cards.filter((card) => only.includes(card.id));
  const selectedIds = new Set(selected.map((card) => card.id));
  const droppedDependencies: CardRegistration["droppedDependencies"] = [];
  const trimmed = selected.map((card) => ({
    ...card,
    depends: card.depends.filter((dependency) => {
      if (selectedIds.has(dependency)) return true;
      droppedDependencies.push({ card: card.id, dependsOn: dependency });
      return false;
    }),
  }));
  return { cards: trimmed.map((card) => CardSchema.parse(card)), brief: options.brief ?? "", briefSource: options.briefSource ?? null, droppedDependencies };
}

const KIND_HINTS: readonly [RegExp, Exclude<TaskKind, "investigation">][] = [
  [/^(?:fix|bug|repair)\b/i, "bugfix"],
  [/\b(?:refactor|rename|extract|move|dedupe|simplify)\b/i, "refactor"],
];

export function cardKind(card: Card): Exclude<TaskKind, "investigation"> {
  for (const [pattern, kind] of KIND_HINTS) if (pattern.test(card.title)) return kind;
  return "feature";
}

/** By write scope: one literal file is trivial, four or more files (or any `**`) is complex. */
export function cardComplexity(card: Card): "trivial" | "normal" | "complex" {
  if (card.files.length >= 4 || card.files.some((file) => file.includes("**"))) return "complex";
  if (card.files.length === 1 && !isGlobPattern(card.files[0] ?? "") && card.goal.length < 400) return "trivial";
  return "normal";
}

/**
 * Checks the engine can run by itself: a test file the card names literally in `files:` must exist
 * and pass when run alone. A glob names no file, so it asks for nothing.
 */
export function cardAcceptanceChecks(card: Card): AcceptanceCheck[] {
  return card.files
    .map(normalizePath)
    .filter((file) => !isGlobPattern(file) && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
    .map((path) => ({ kind: "test_file" as const, path }));
}

/** The task description a worker reads: the card's own words and its write scope. */
export function cardDescription(card: Card, dependencyTitles: readonly string[] = []): string {
  return [
    `Card ${card.id}: ${card.title}`,
    "",
    card.goal,
    ...(card.notes === undefined ? [] : ["", `Notes: ${card.notes}`]),
    "",
    `Files you may change (the gate rejects any other changed file): ${card.files.join(", ")}`,
    ...(dependencyTitles.length === 0 ? [] : [`Builds on: ${dependencyTitles.join("; ")}`]),
  ].join("\n");
}
