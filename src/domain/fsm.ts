import { PolishError } from "../shared/errors.js";

/**
 * Generic transition-table FSM. Tables are data so they can be property-tested:
 * reachability, terminal states have no outgoing edges, etc.
 */
export interface TransitionTable<S extends string> {
  readonly initial: S;
  readonly states: readonly S[];
  readonly terminal: readonly S[];
  readonly edges: Readonly<Record<S, readonly S[]>>;
}

export function canTransition<S extends string>(table: TransitionTable<S>, from: S, to: S): boolean {
  return table.edges[from].includes(to);
}

export function assertTransition<S extends string>(table: TransitionTable<S>, entity: string, from: S, to: S): void {
  if (!canTransition(table, from, to)) {
    throw new PolishError("INVALID_TRANSITION", `${entity}: ${from} -> ${to} is not allowed`, { entity, from, to });
  }
}

export function isTerminal<S extends string>(table: TransitionTable<S>, state: S): boolean {
  return table.terminal.includes(state);
}

/** States reachable from `initial` following edges. */
export function reachableStates<S extends string>(table: TransitionTable<S>): Set<S> {
  const seen = new Set<S>([table.initial]);
  const stack: S[] = [table.initial];
  for (let s = stack.pop(); s !== undefined; s = stack.pop()) {
    for (const next of table.edges[s]) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

