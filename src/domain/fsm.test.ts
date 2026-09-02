import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CANDIDATE_TABLE } from "./candidate.js";
import { FINDING_TABLE } from "./finding.js";
import { canTransition, validateTable, type TransitionTable } from "./fsm.js";
import { JOB_TABLE } from "./job.js";
import {
  CODE_CHANGING_PHASES,
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

const TABLES: [string, TransitionTable<string>][] = [
  ["RUN_PHASE_TABLE", RUN_PHASE_TABLE],
  ["RUN_CONTROL_TABLE", RUN_CONTROL_TABLE],
  ["TASK_TABLE", TASK_TABLE],
  ["CANDIDATE_TABLE", CANDIDATE_TABLE],
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

  it("review is reachable only through integration (never straight from comparing)", () => {
    expect(canTransition(RUN_PHASE_TABLE, "COMPARING", "REVIEWING")).toBe(false);
    expect(canTransition(RUN_PHASE_TABLE, "INTEGRATING", "REVIEWING")).toBe(true);
  });

  it("simplification must pass through gates again before convergence can be re-checked with new code", () => {
    expect(canTransition(RUN_PHASE_TABLE, "SIMPLIFYING", "GATING")).toBe(true);
    expect(canTransition(RUN_PHASE_TABLE, "SIMPLIFYING", "DONE")).toBe(false);
    expect(canTransition(RUN_PHASE_TABLE, "SIMPLIFYING", "REVIEWING")).toBe(false);
  });

  it("DONE is reachable only from CONVERGENCE_CHECK", () => {
    for (const s of RUN_PHASE_TABLE.states) {
      if (s === "CONVERGENCE_CHECK") continue;
      expect(canTransition(RUN_PHASE_TABLE, s, "DONE")).toBe(false);
    }
  });

  it("code-changing phases are exactly integration and simplification", () => {
    expect([...CODE_CHANGING_PHASES].sort()).toEqual(["INTEGRATING", "SIMPLIFYING"]);
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

  it("kill is absorbing and stop is irreversible", () => {
    fc.assert(
      fc.property(fc.array(commandArb, { maxLength: 10 }), (cmds) => {
        let c = applyControlCommand("RUNNING", "kill");
        for (const cmd of cmds) c = applyControlCommand(c, cmd);
        expect(c).toBe("KILLED");
      }),
    );
    fc.assert(
      fc.property(fc.array(fc.constantFrom("pause", "resume", "quiesced", "stopped"), { maxLength: 10 }), (cmds) => {
        let c = applyControlCommand("RUNNING", "stop");
        for (const cmd of cmds) c = applyControlCommand(c, cmd);
        expect(["STOP_REQUESTED", "STOPPED"]).toContain(c);
      }),
    );
  });

  it("pause drains, stop/kill cancel; only RUNNING dispatches new jobs", () => {
    expect(mayDispatchJobs("RUNNING")).toBe(true);
    for (const c of RunControlSchema.options) if (c !== "RUNNING") expect(mayDispatchJobs(c)).toBe(false);
    expect(mustCancelInFlight("PAUSE_REQUESTED")).toBe(false);
    expect(mustCancelInFlight("PAUSED")).toBe(false);
    expect(mustCancelInFlight("STOP_REQUESTED")).toBe(true);
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
    expect(canTransition(TASK_TABLE, "SELECTED", "QUEUED_FOR_INTEGRATION")).toBe(true);
    expect(canTransition(TASK_TABLE, "INTEGRATING", "INTEGRATED")).toBe(true);
    expect(canTransition(TASK_TABLE, "INTEGRATION_FAILED", "READY")).toBe(true);
  });
});

describe("candidate FSM", () => {
  it("a candidate cannot win without passing gates", () => {
    for (const s of CANDIDATE_TABLE.states) {
      if (s === "PASSED_GATES") continue;
      expect(canTransition(CANDIDATE_TABLE, s, "WINNER")).toBe(false);
    }
  });
});
