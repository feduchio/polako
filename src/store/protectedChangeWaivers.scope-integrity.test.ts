import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewEvent } from "../domain/event.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { ProtectedChangeWaiverService, openStore, type Store } from "./index.js";

const NOW = 1_700_000_000_000;

function waiverInput(runId: string) {
  return {
    runId,
    missionId: id("msn"),
    taskId: id("task"),
    requirementId: "R1",
    baseCheckpointHash: "a".repeat(40),
    pathScope: ["./checks/../checks/protected.ts"],
    findingKind: "modified",
    justification: "validated replacement",
    causeEventId: id("evt"),
    issuedBy: { kind: "supervisor" as const },
    validatedBy: { kind: "reviewer" as const, role: "validator" },
  };
}

function evidenceEvent(
  runId: string,
  input: ReturnType<typeof waiverInput>,
  overrides: Partial<NewEvent["payload"]> = {},
): NewEvent {
  return {
    id: id("evt"),
    runId,
    ts: NOW,
    type: "finding.validated",
    payload: {
      waiverScope: {
        requirementId: input.requirementId,
        taskId: input.taskId,
        baseCheckpointHash: input.baseCheckpointHash,
        relativePath: input.pathScope[0]!,
        findingKind: input.findingKind,
      },
      ...overrides,
    },
    causedBy: [],
    actor: { kind: "reviewer", role: "validator" },
    artifacts: [],
  };
}

describe("protected change waiver scope integrity", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-waiver-scope-"));
    store = openStore({ home: dir });
    clock = new FakeClock(NOW);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects evidence whose scope does not match the waiver and empty review.finished payloads", () => {
    const runId = id("run");
    const input = waiverInput(runId);
    const service = new ProtectedChangeWaiverService(store, clock);

    const mismatched = store.events.append([evidenceEvent(runId, input, {
      waiverScope: {
        requirementId: "other",
        taskId: input.taskId,
        baseCheckpointHash: input.baseCheckpointHash,
        relativePath: input.pathScope[0]!,
        findingKind: input.findingKind,
      },
    })])[0]!;
    expect(() => service.record({ ...input, causeEventId: mismatched.id })).toThrow(/scope does not match/);

    const emptyReview = store.events.append([{
      id: id("evt"),
      runId,
      ts: NOW,
      type: "review.finished",
      payload: {},
      causedBy: [],
      actor: { kind: "reviewer", role: "validator" },
      artifacts: [],
    }])[0]!;
    expect(() => service.record({ ...input, causeEventId: emptyReview.id })).toThrow(/scope does not match/);
  });

  it("normalizes waiver paths and revalidates scope semantics in isValidated", () => {
    const runId = id("run");
    const input = waiverInput(runId);
    const evidence = store.events.append([evidenceEvent(runId, input)])[0]!;
    const service = new ProtectedChangeWaiverService(store, clock);
    const waiver = service.record({ ...input, causeEventId: evidence.id });
    expect(waiver.pathScope).toEqual(["checks/protected.ts"]);
    expect(service.isValidated(waiver)).toBe(true);
    expect(service.isValidated({
      ...waiver,
      pathScope: ["./checks/protected.ts"],
    })).toBe(true);
    expect(service.isValidated({
      ...waiver,
      findingKind: "other",
    })).toBe(false);
  });

  it("does not let one validated path bless extra waiver pathScope members", () => {
    const runId = id("run");
    const input = {
      ...waiverInput(runId),
      pathScope: ["tests/a.test.ts", "tests/b.test.ts"],
    };
    const evidence = store.events.append([evidenceEvent(runId, {
      ...input,
      pathScope: ["tests/a.test.ts"],
    })])[0]!;
    const service = new ProtectedChangeWaiverService(store, clock);
    expect(() => service.record({ ...input, causeEventId: evidence.id })).toThrow(/scope does not match/);

    const attested = store.events.append([evidenceEvent(runId, input, {
      waiverScope: {
        requirementId: input.requirementId,
        taskId: input.taskId,
        baseCheckpointHash: input.baseCheckpointHash,
        relativePath: "tests/a.test.ts",
        relativePaths: ["tests/a.test.ts", "tests/b.test.ts"],
        findingKind: input.findingKind,
      },
    })])[0]!;
    const waiver = service.record({ ...input, causeEventId: attested.id });
    expect(waiver.pathScope).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
    expect(service.isValidated(waiver)).toBe(true);
    expect(service.isValidated({ ...waiver, pathScope: ["tests/a.test.ts", "tests/extra.test.ts"] })).toBe(false);
  });
});
