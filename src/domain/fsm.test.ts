import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FINDING_TABLE } from "./finding.js";
import { canTransition, reachableStates, type TransitionTable } from "./fsm.js";
import { JOB_TABLE } from "./job.js";
import {
  CODE_CHANGING_PHASES,
  REVIEW_ENTRY_PHASES,
  ControlCommandSchema,
  RUN_CONTROL_TABLE,
  RUN_PHASE_TABLE,
  RunControlSchema,
  RunPhaseSchema,
  applyControlCommand,
  mayDispatchJobs,
  mustCancelInFlight,
} from "./run.js";
import { TASK_TABLE } from "./task.js";

/** Structural check. It lives with the tests because production never calls it. */
function validateTable<S extends string>(table: TransitionTable<S>): string[] {
  const problems: string[] = [];
  const stateSet = new Set(table.states);
  if (!stateSet.has(table.initial)) problems.push(`initial ${table.initial} not in states`);
  for (const s of table.states) {
    const edges = table.edges[s] as readonly S[] | undefined;
    if (!edges) {
      problems.push(`state ${s} has no edge entry`);
      continue;
    }
    for (const t of edges) if (!stateSet.has(t)) problems.push(`edge ${s} -> ${t} targets unknown state`);
    if (table.terminal.includes(s) && edges.length > 0) problems.push(`terminal ${s} has outgoing edges`);
    if (!table.terminal.includes(s) && edges.length === 0) problems.push(`non-terminal ${s} is a dead end`);
  }
  const reachable = reachableStates(table);
  for (const s of table.states) if (!reachable.has(s)) problems.push(`state ${s} unreachable from ${table.initial}`);
  return problems;
}

const TABLES: [string, TransitionTable<string>][] = [
  ["RUN_PHASE_TABLE", RUN_PHASE_TABLE],
  ["RUN_CONTROL_TABLE", RUN_CONTROL_TABLE],
  ["TASK_TABLE", TASK_TABLE],
  ["FINDING_TABLE", FINDING_TABLE],
  ["JOB_TABLE", JOB_TABLE],
];

describe("transition tables are structurally sound", () => {
  for (const [name, table] of TABLES) {
    it(`${name}: all states reachable, terminals closed, no dead ends`, () => {
      expect(validateTable(table)).toEqual([]);
    });
  }
});

describe("run phase FSM", () => {
  it("terminal phases have no outgoing transitions", () => {
    for (const t of RUN_PHASE_TABLE.terminal) expect(RUN_PHASE_TABLE.edges[t]).toEqual([]);
  });

  it("mission interpretation happens only after discovery and baseline", () => {
    expect(canTransition(RUN_PHASE_TABLE, "CREATED", "INTERPRETING_MISSION")).toBe(false);
    expect(canTransition(RUN_PHASE_TABLE, "DISCOVERING_PROJECT", "INTERPRETING_MISSION")).toBe(false);
    expect(canTransition(RUN_PHASE_TABLE, "BASELINING", "INTERPRETING_MISSION")).toBe(true);
  });

  it("review is entered only from integration, planning or convergence check — never from comparing/gating/executing", () => {
    const incoming = RUN_PHASE_TABLE.states.filter((s) => canTransition(RUN_PHASE_TABLE, s, "REVIEWING")).sort();
    expect(incoming).toEqual([...REVIEW_ENTRY_PHASES].sort());
    expect(incoming).not.toContain("COMPARING");
    expect(incoming).not.toContain("GATING");
    expect(incoming).not.toContain("EXECUTING");
  });

  it("simplification cannot change code by itself: it only plans tasks or returns with nothing to do", () => {
    expect(canTransition(RUN_PHASE_TABLE, "SIMPLIFYING", "EXECUTING")).toBe(true);
    expect(canTransition(RUN_PHASE_TABLE, "SIMPLIFYING", "CONVERGENCE_CHECK")).toBe(true);
    for (const s of ["GATING", "COMPARING", "INTEGRATING", "REVIEWING", "DONE"] as const) {
      expect(canTransition(RUN_PHASE_TABLE, "SIMPLIFYING", s)).toBe(false);
    }
  });

  it("INTEGRATING is the only code-changing phase and is entered only from COMPARING", () => {
    expect(CODE_CHANGING_PHASES).toEqual(["INTEGRATING"]);
    const incoming = RUN_PHASE_TABLE.states.filter((s) => canTransition(RUN_PHASE_TABLE, s, "INTEGRATING"));
    expect(incoming).toEqual(["COMPARING"]);
  });

  it("DONE is reachable only from CONVERGENCE_CHECK", () => {
    for (const s of RUN_PHASE_TABLE.states) {
      if (s === "CONVERGENCE_CHECK") continue;
      expect(canTransition(RUN_PHASE_TABLE, s, "DONE")).toBe(false);
    }
  });

});

describe("run control axis", () => {
  const controlArb = fc.constantFrom(...RunControlSchema.options);
  const commandArb = fc.constantFrom(...ControlCommandSchema.options);

  it("every command is total: any (control, command) yields a control state listed in the table", () => {
    fc.assert(
      fc.property(controlArb, commandArb, (c, cmd) => {
        const next = applyControlCommand(c, cmd);
        expect(RUN_CONTROL_TABLE.states).toContain(next);
        if (next !== c) expect(canTransition(RUN_CONTROL_TABLE, c, next)).toBe(true);
      }),
    );
  });

  it("any command sequence from any phase is valid (axes are orthogonal)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...RunPhaseSchema.options), fc.array(commandArb, { maxLength: 20 }), (_phase, cmds) => {
        let c: (typeof RunControlSchema.options)[number] = "RUNNING";
        for (const cmd of cmds) c = applyControlCommand(c, cmd);
        expect(RUN_CONTROL_TABLE.states).toContain(c);
      }),
    );
  });

  it("kill is absorbing; stopped remains stopped until explicit resume", () => {
    fc.assert(
      fc.property(fc.array(commandArb, { maxLength: 10 }), (cmds) => {
        let c = applyControlCommand("RUNNING", "kill");
        for (const cmd of cmds) c = applyControlCommand(c, cmd);
        expect(c).toBe("KILLED");
      }),
    );
    fc.assert(
      fc.property(fc.array(fc.constantFrom("pause", "quiesced", "stopped"), { maxLength: 10 }), (cmds) => {
        let c = applyControlCommand("RUNNING", "stop");
        for (const cmd of cmds) c = applyControlCommand(c, cmd);
        expect(["STOP_REQUESTED", "STOPPED"]).toContain(c);
      }),
    );
    expect(applyControlCommand("STOPPED", "resume")).toBe("RUNNING");
  });

  it("pause drains, stop/kill cancel; only RUNNING dispatches new jobs", () => {
    expect(mayDispatchJobs("RUNNING")).toBe(true);
    for (const c of RunControlSchema.options) if (c !== "RUNNING") expect(mayDispatchJobs(c)).toBe(false);
    expect(mustCancelInFlight("PAUSE_REQUESTED")).toBe(false);
    expect(mustCancelInFlight("PAUSED")).toBe(false);
    expect(mustCancelInFlight("STOP_REQUESTED")).toBe(true);
    expect(mustCancelInFlight("STOPPED")).toBe(true);
    expect(mustCancelInFlight("KILLED")).toBe(true);
  });

  it("pause -> quiesced -> resume round-trips to RUNNING", () => {
    const paused = applyControlCommand(applyControlCommand("RUNNING", "pause"), "quiesced");
    expect(paused).toBe("PAUSED");
    expect(applyControlCommand(paused, "resume")).toBe("RUNNING");
  });
});

describe("task FSM", () => {
  it("integration is the only path to INTEGRATED and is serial-queue gated", () => {
    expect(canTransition(TASK_TABLE, "SELECTED", "INTEGRATED")).toBe(false);
    expect(canTransition(TASK_TABLE, "SELECTED", "INTEGRATING")).toBe(true);
    expect(canTransition(TASK_TABLE, "GATED", "INTEGRATING")).toBe(false);
    expect(canTransition(TASK_TABLE, "INTEGRATING", "INTEGRATED")).toBe(true);
    expect(canTransition(TASK_TABLE, "INTEGRATION_FAILED", "READY")).toBe(true);
  });
});

