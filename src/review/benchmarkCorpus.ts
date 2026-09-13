import { Script, createContext } from "node:vm";
import { sha256Hex } from "../shared/hash.js";

export const BENCHMARK_PATH = "src/subject.ts";

export type DefectFamily =
  | "off_by_one"
  | "null_zero"
  | "latest_snapshot"
  | "swallowed_failure"
  | "prompt_first_turn_only"
  | "missing_identity"
  | "priority_vs_recency"
  | "illegal_transition";

interface Invariant {
  name: string;
  test(api: Record<string, unknown>): boolean;
}

export interface ReviewerBenchmarkPair {
  pairId: string;
  criterionId: string;
  property: string;
  family: DefectFamily;
  path: typeof BENCHMARK_PATH;
  cleanSource: string;
  mutantSource: string;
  invariants: readonly [Invariant, Invariant, Invariant];
}

export interface InvariantResult {
  name: string;
  passed: boolean;
}

export const REVIEWER_BENCHMARK_PAIRS: readonly ReviewerBenchmarkPair[] = [
  pair(
    "pair-01",
    "INV-01",
    "spending equal to an exclusive cap is rejected",
    "off_by_one",
    "module.exports.withinBudget = (spent, cap) => spent < cap;",
    "module.exports.withinBudget = (spent, cap) => spent <= cap;",
    [
      invariant("equal cap rejected", (api) => invoke(api, "withinBudget", 5, 5) === false),
      invariant("below cap accepted", (api) => invoke(api, "withinBudget", 4, 5) === true),
      invariant("above cap rejected", (api) => invoke(api, "withinBudget", 6, 5) === false),
    ],
  ),
  pair(
    "pair-02",
    "INV-02",
    "a recorded numeric zero is preserved",
    "null_zero",
    "module.exports.restore = (value) => value ?? 7;",
    "module.exports.restore = (value) => value || 7;",
    [
      invariant("zero preserved", (api) => invoke(api, "restore", 0) === 0),
      invariant("null defaults", (api) => invoke(api, "restore", null) === 7),
      invariant("positive preserved", (api) => invoke(api, "restore", 3) === 3),
    ],
  ),
  pair(
    "pair-03",
    "INV-03",
    "the latest snapshot determines current state",
    "latest_snapshot",
    "module.exports.latest = (values) => values.at(-1);",
    "module.exports.latest = (values) => values.at( 0);",
    [
      invariant("latest wins", (api) => invoke(api, "latest", ["READY", "DONE"]) === "DONE"),
      invariant("single value survives", (api) => invoke(api, "latest", ["READY"]) === "READY"),
      invariant("empty is undefined", (api) => invoke(api, "latest", []) === undefined),
    ],
  ),
  pair(
    "pair-04",
    "INV-04",
    "a thrown operation is never reported as successful",
    "swallowed_failure",
    "module.exports.run = (fn) => { try { return { ok: true, value: fn() }; } catch { return { ok: false }; } };",
    "module.exports.run = (fn) => { try { return { ok: true, value: fn() }; } catch { return { ok: true  }; } };",
    [
      invariant("throw is failure", (api) => {
        const result = invoke(api, "run", () => { throw new Error("x"); });
        return record(result)?.["ok"] === false;
      }),
      invariant("success is success", (api) => record(invoke(api, "run", () => 3))?.["ok"] === true),
      invariant("success value retained", (api) => record(invoke(api, "run", () => 3))?.["value"] === 3),
    ],
  ),
  pair(
    "pair-05",
    "INV-05",
    "the standing prompt is present on every turn",
    "prompt_first_turn_only",
    "module.exports.wire = (_turn, pack) => [pack];",
    "module.exports.wire = ( turn, pack) => turn === 0 ? [pack] : [];",
    [
      invariant("later turn carries prompt", (api) => array(invoke(api, "wire", 4, "P"))[0] === "P"),
      invariant("first turn carries prompt", (api) => array(invoke(api, "wire", 0, "P"))[0] === "P"),
      invariant("prompt bytes preserved", (api) => array(invoke(api, "wire", 0, "exact"))[0] === "exact"),
    ],
  ),
  pair(
    "pair-06",
    "INV-06",
    "events without call ids retain distinct identities",
    "missing_identity",
    "module.exports.key = (event) => event.callId ?? event.id;",
    "module.exports.key = (event) => event.callId ?? null;",
    [
      invariant("missing ids stay distinct", (api) =>
        invoke(api, "key", { id: "a" }) !== invoke(api, "key", { id: "b" })),
      invariant("call id wins", (api) => invoke(api, "key", { id: "a", callId: "c" }) === "c"),
      invariant("input is not mutated", (api) => {
        const value = { id: "a" };
        invoke(api, "key", value);
        return Object.keys(value).length === 1 && value.id === "a";
      }),
    ],
  ),
  pair(
    "pair-07",
    "INV-07",
    "priority outranks recency",
    "priority_vs_recency",
    "module.exports.pick = (xs) => [...xs].sort((a,b) => a.priority-b.priority || b.seq-a.seq)[0];",
    "module.exports.pick = (xs) => [...xs].sort((a,b) => b.seq-a.seq || a.priority-b.priority)[0];",
    [
      invariant("priority wins", (api) =>
        record(invoke(api, "pick", [{ id: "old-high", priority: 0, seq: 1 }, { id: "new-low", priority: 2, seq: 9 }]))?.["id"] === "old-high"),
      invariant("recency breaks equal priority", (api) =>
        record(invoke(api, "pick", [{ id: "old", priority: 1, seq: 1 }, { id: "new", priority: 1, seq: 2 }]))?.["id"] === "new"),
      invariant("input is not reordered", (api) => {
        const values = [{ id: "a", priority: 1, seq: 1 }, { id: "b", priority: 0, seq: 2 }];
        invoke(api, "pick", values);
        return values[0]?.id === "a";
      }),
    ],
  ),
  pair(
    "pair-08",
    "INV-08",
    "review exhaustion transitions only to a legal terminal phase",
    "illegal_transition",
    "module.exports.next = (exhausted) => exhausted ? \"FAILED\"      : \"VALIDATING\";",
    "module.exports.next = (exhausted) => exhausted ? \"NEEDS_HUMAN\" : \"VALIDATING\";",
    [
      invariant("exhausted phase is legal", (api) => invoke(api, "next", true) === "FAILED"),
      invariant("healthy phase validates", (api) => invoke(api, "next", false) === "VALIDATING"),
      invariant("exhausted phase is terminal", (api) => ["DONE", "NEEDS_HUMAN", "FAILED"].includes(String(invoke(api, "next", true)))),
    ],
  ),
];

export function sourceFor(pairValue: ReviewerBenchmarkPair, label: "clean" | "mutant"): string {
  return label === "clean" ? pairValue.cleanSource : pairValue.mutantSource;
}

export function runInvariants(
  pairValue: ReviewerBenchmarkPair,
  label: "clean" | "mutant",
): InvariantResult[] {
  const api = evaluate(sourceFor(pairValue, label));
  return pairValue.invariants.map((item) => ({ name: item.name, passed: item.test(api) }));
}

export function changedLineSpan(pairValue: ReviewerBenchmarkPair): { line: number; endLine: number } {
  const clean = pairValue.cleanSource.split("\n");
  const mutant = pairValue.mutantSource.split("\n");
  const changed: number[] = [];
  const length = Math.max(clean.length, mutant.length);
  for (let index = 0; index < length; index++) {
    if (clean[index] !== mutant[index]) changed.push(index + 1);
  }
  if (changed.length !== 1) throw new Error(`${pairValue.pairId} must change exactly one line`);
  const [line] = changed;
  if (line === undefined) throw new Error(`${pairValue.pairId} has no changed line`);
  return { line, endLine: line };
}

export function addedFileDiff(pairValue: ReviewerBenchmarkPair, label: "clean" | "mutant"): string {
  const source = sourceFor(pairValue, label);
  const lines = source.split("\n");
  return [
    "--- /dev/null",
    `+++ b/${pairValue.path}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export function benchmarkCorpusSha256(
  pairs: readonly ReviewerBenchmarkPair[] = REVIEWER_BENCHMARK_PAIRS,
): string {
  return sha256Hex(JSON.stringify(pairs.map((pairValue) => ({
    pairId: pairValue.pairId,
    criterionId: pairValue.criterionId,
    property: pairValue.property,
    family: pairValue.family,
    path: pairValue.path,
    cleanSource: pairValue.cleanSource,
    mutantSource: pairValue.mutantSource,
    invariantNames: pairValue.invariants.map((item) => item.name),
  }))));
}

function pair(
  pairId: string,
  criterionId: string,
  property: string,
  family: DefectFamily,
  cleanLine: string,
  mutantLine: string,
  invariants: readonly [Invariant, Invariant, Invariant],
): ReviewerBenchmarkPair {
  const prefix = `// ${criterionId}: ${property}\n`;
  return {
    pairId,
    criterionId,
    property,
    family,
    path: BENCHMARK_PATH,
    cleanSource: `${prefix}${cleanLine}\n`,
    mutantSource: `${prefix}${mutantLine}\n`,
    invariants,
  };
}

function invariant(name: string, test: Invariant["test"]): Invariant {
  return { name, test };
}

function evaluate(source: string): Record<string, unknown> {
  const context = createContext({ module: { exports: {} } });
  new Script(source, { filename: BENCHMARK_PATH }).runInContext(context);
  return record((context as { module?: { exports?: unknown } }).module?.exports) ?? {};
}

function invoke(api: Record<string, unknown>, name: string, ...args: unknown[]): unknown {
  const fn = api[name];
  if (typeof fn !== "function") throw new TypeError(`${name} is not callable`);
  return Reflect.apply(fn, undefined, args);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
