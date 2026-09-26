import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCallRecord } from "../broker/broker.js";
import type { ProviderAdapter, CompletionRequest, CompletionResponse, ModelInfo, ProviderHealth } from "../broker/types.js";
import { isBudgetError } from "../broker/quota.js";
import type { PathologyBudgetSnapshot, PathologySample } from "../convergence/pathology/types.js";
import { isKnownEventType } from "../domain/event.js";
import { id } from "../shared/ids.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import { FakeClock } from "../shared/clock.js";
import { PolishError } from "../shared/errors.js";
import { DaemonService } from "./service.js";

const dirs: string[] = [];
const services: DaemonService[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * B-selfhost-8: `--budget-tokens` / `--budget-usd` were validated, persisted and ignored.
 * Enforcement lives in `BudgetTracker.assertWithin`, reached only through a real broker
 * call, so these drive `handle("run", …)` and then `broker.complete(...)`.
 */
describe("B-selfhost-8 per-run budget overrides", () => {
  it("binds a token override that the loaded configuration would have allowed", async () => {
    const fixture = await daemonFixture({ maxRunTokens: null });
    const runId = await fixture.createRun({ budgetTokens: 30 });

    await callTimes(fixture, runId, 3);
    const error = await budgetErrorOf(fixture.call(runId));
    expect(error.details).toMatchObject({ budget: "run_tokens", limit: 30 });
  });

  it("binds a USD override on priced calls", async () => {
    const fixture = await daemonFixture({ maxRunUsd: null, costUsd: 0.5 });
    const runId = await fixture.createRun({ budgetUsd: 1.25 });

    await callTimes(fixture, runId, 3);
    const error = await budgetErrorOf(fixture.call(runId));
    expect(error.details).toMatchObject({ budget: "run_usd", limit: 1.25 });
  });

  it("enforces both flags on one run, each at its own threshold", async () => {
    const fixture = await daemonFixture({ maxRunTokens: null, maxRunUsd: null, costUsd: 0.5 });
    const tokenBound = await fixture.createRun({ budgetTokens: 30, budgetUsd: 1000 });
    const usdBound = await fixture.createRun({ budgetTokens: 1_000_000, budgetUsd: 1 });

    await callTimes(fixture, tokenBound, 3);
    expect((await budgetErrorOf(fixture.call(tokenBound))).details).toMatchObject({ budget: "run_tokens", limit: 30 });

    await callTimes(fixture, usdBound, 2);
    expect((await budgetErrorOf(fixture.call(usdBound))).details).toMatchObject({ budget: "run_usd", limit: 1 });
  });

  it("does not leak an override onto a run created earlier", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const earlier = await fixture.createRun({});
    await fixture.createRun({ budgetTokens: 20 });

    await callTimes(fixture, earlier, 5);
    expect((await budgetErrorOf(fixture.call(earlier))).details).toMatchObject({ limit: 50 });
  });

  it("does not leak an override onto a run created later", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    await fixture.createRun({ budgetTokens: 20 });
    const later = await fixture.createRun({});

    await callTimes(fixture, later, 5);
    expect((await budgetErrorOf(fixture.call(later))).details).toMatchObject({ limit: 50 });
  });

  it("keeps each run on its own limit while another run's call is in flight", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const parked = await fixture.createRun({ budgetTokens: 100 });
    const small = await fixture.createRun({ budgetTokens: 20 });

    await callTimes(fixture, small, 2);
    fixture.gate.parkRun(parked);
    const inFlight = fixture.call(parked);
    await fixture.gate.arrived;

    // `parked` is suspended inside the provider, past its own assertWithin.
    expect((await budgetErrorOf(fixture.call(small))).details).toMatchObject({ limit: 20 });
    const third = await fixture.createRun({ budgetTokens: 30 });
    await callTimes(fixture, third, 3);
    expect((await budgetErrorOf(fixture.call(third))).details).toMatchObject({ limit: 30 });

    fixture.gate.release();
    await expect(inFlight).resolves.toBeDefined();
    await callTimes(fixture, parked, 9);
    expect((await budgetErrorOf(fixture.call(parked))).details).toMatchObject({ limit: 100 });
  });

  it("leaves the daemon-wide limits in force for later runs without overrides", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const overridden = await fixture.createRun({ budgetTokens: 20 });
    await callTimes(fixture, overridden, 2);
    await budgetErrorOf(fixture.call(overridden));

    expect(fixture.service.getConfig().budget).toEqual({
      maxRunUsd: null,
      maxRunTokens: 50,
      maxAttemptTokens: null,
      maxTaskTokens: null,
      maxRunWallClockMinutes: null,
    });
    const plain = await fixture.createRun({});
    await callTimes(fixture, plain, 5);
    expect((await budgetErrorOf(fixture.call(plain))).details).toMatchObject({ limit: 50 });
  });

  /**
   * Replaces the source grep this file used to carry, which a bracket-notation assignment or an
   * `Object.assign` evaded. What it was reaching for — a run's limits never reach another run or
   * the shared config — is what the isolation checks above and below actually drive.
   */
  it("leaves the daemon-wide budget untouched after a run resolves its own", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50, maxRunUsd: 4 });
    const before = { ...fixture.service.getConfig().budget };
    const overridden = await fixture.createRun({ budgetTokens: 30, budgetUsd: 1 });
    await callTimes(fixture, overridden, 1);
    expect(fixture.service.getConfig().budget).toEqual(before);

    const plain = await fixture.createRun({});
    await callTimes(fixture, plain, 5);
    expect((await budgetErrorOf(fixture.call(plain))).details).toMatchObject({ limit: 50 });
  });

  it("treats a null configured limit as unlimited when a run has no override", async () => {
    const fixture = await daemonFixture({ maxRunTokens: null });
    const runId = await fixture.createRun({});
    for (let i = 0; i < 40; i += 1) await expect(fixture.call(runId)).resolves.toBeDefined();
  });

  it("lets an override raise a finite configured cap", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const raised = await fixture.createRun({ budgetTokens: 100 });
    const plain = await fixture.createRun({});

    // Past the configured cap and still running: the override raised it, it did not clamp.
    await callTimes(fixture, raised, 6);
    await callTimes(fixture, plain, 5);
    expect((await budgetErrorOf(fixture.call(plain))).details).toMatchObject({ limit: 50 });

    await callTimes(fixture, raised, 4);
    expect((await budgetErrorOf(fixture.call(raised))).details).toMatchObject({ limit: 100 });
  });

  it("replaces a finite configured USD cap in both directions", async () => {
    // Against a `null` configured cap there is nothing to clamp or floor against, so only a
    // finite one can tell replacement from either. The token twin of this runs above.
    const fixture = await daemonFixture({ maxRunTokens: null, maxRunUsd: 4, costUsd: 0.5 });
    const raised = await fixture.createRun({ budgetUsd: 9 });
    const lowered = await fixture.createRun({ budgetUsd: 1 });
    const plain = await fixture.createRun({});

    await callTimes(fixture, lowered, 2);
    expect((await budgetErrorOf(fixture.call(lowered))).details).toMatchObject({ budget: "run_usd", limit: 1 });

    // Past the configured cap and still running, then bound by its own.
    await callTimes(fixture, raised, 8);
    await callTimes(fixture, plain, 8);
    expect((await budgetErrorOf(fixture.call(plain))).details).toMatchObject({ budget: "run_usd", limit: 4 });
    await callTimes(fixture, raised, 10);
    expect((await budgetErrorOf(fixture.call(raised))).details).toMatchObject({ budget: "run_usd", limit: 9 });
  });

  it("keeps the configured USD cap for a run with no override and one that overrides tokens", async () => {
    // The dimension a token override does not name must survive it, and must survive the new
    // per-run resolution for a run that names nothing at all.
    const fixture = await daemonFixture({ maxRunTokens: null, maxRunUsd: 1, costUsd: 0.5 });
    const plain = await fixture.createRun({});
    const tokenOnly = await fixture.createRun({ budgetTokens: 1_000_000 });

    await callTimes(fixture, plain, 2);
    expect((await budgetErrorOf(fixture.call(plain))).details).toMatchObject({ budget: "run_usd", limit: 1 });

    await callTimes(fixture, tokenOnly, 2);
    expect((await budgetErrorOf(fixture.call(tokenOnly))).details).toMatchObject({ budget: "run_usd", limit: 1 });
  });

  it("binds a run's own caps on calls that name a task, which is the shape production sends", async () => {
    // `AgentRunner` passes `taskId` on every call it makes, and every other check here omits it,
    // so a guard that skipped the run-level caps whenever a task was named would go unseen.
    // Both per-task caps are left unset, so only the run-level ones can produce these throws.
    const fixture = await daemonFixture({ maxRunTokens: null, maxRunUsd: null, maxTaskTokens: null, costUsd: 0.5 });
    const tokenBound = await fixture.createRun({ budgetTokens: 30 });
    const usdBound = await fixture.createRun({ budgetUsd: 1 });

    await callTimes(fixture, tokenBound, 3, "task_1");
    expect((await budgetErrorOf(fixture.call(tokenBound, "task_1"))).details).toMatchObject({ budget: "run_tokens", limit: 30 });

    await callTimes(fixture, usdBound, 2, "task_1");
    expect((await budgetErrorOf(fixture.call(usdBound, "task_1"))).details).toMatchObject({ budget: "run_usd", limit: 1 });
  });

  it("sums a run's spend across its tasks, and across calls that name none", async () => {
    // One `AgentRunner` per task means a single run's spend arrives under several task ids,
    // while council and review calls name none at all. A run cap that counted only one task's
    // share, or only the unnamed calls, would never bind on a real run.
    const fixture = await daemonFixture({ maxRunTokens: null, maxRunUsd: null, maxTaskTokens: null, costUsd: 0.5 });
    const runId = await fixture.createRun({ budgetTokens: 30 });

    await callTimes(fixture, runId, 1, "task_a");
    await callTimes(fixture, runId, 1);
    await callTimes(fixture, runId, 1, "task_b");

    // The cap is already reached, and a refusal records nothing, so every shape the next call
    // could take must meet it: a task that has never spent -- which is what a new agent's first
    // call looks like -- one that has, and a call naming no task at all.
    for (const taskId of ["task_c", undefined, "task_a"]) {
      expect((await budgetErrorOf(fixture.call(runId, taskId))).details).toMatchObject({ budget: "run_tokens", limit: 30 });
    }

    const usdRun = await fixture.createRun({ budgetUsd: 1 });
    await callTimes(fixture, usdRun, 1, "task_a");
    await callTimes(fixture, usdRun, 1, "task_b");
    expect((await budgetErrorOf(fixture.call(usdRun, "task_c"))).details).toMatchObject({ budget: "run_usd", limit: 1 });
  });

  it("keeps the configured per-task cap for a run that overrides run tokens", async () => {
    const fixture = await daemonFixture({ maxRunTokens: null, maxTaskTokens: 30 });
    const runId = await fixture.createRun({ budgetTokens: 1_000_000 });

    await callTimes(fixture, runId, 3, "task_1");
    const error = await budgetErrorOf(fixture.call(runId, "task_1"));
    expect(error.details).toMatchObject({ budget: "task_tokens", limit: 30 });
  });

  it("charges the per-task cap to each attempt, so a retry does not start exhausted, across a restart too", async () => {
    const fixture = await daemonFixture({ maxRunTokens: null, maxTaskTokens: 30 });
    const runId = await fixture.createRun({ budgetTokens: 1_000_000 });
    for (let i = 0; i < 3; i += 1) await expect(fixture.call(runId, "task_1", 1)).resolves.toBeDefined();

    expect((await budgetErrorOf(fixture.call(runId, "task_1", 1))).details).toMatchObject({ budget: "task_tokens", limit: 30 });
    await expect(fixture.call(runId, "task_1", 2)).resolves.toBeDefined();

    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);
    const restarted = fixture.restart();
    expect((await budgetErrorOf(restarted.call(runId, "task_1", 1))).details).toMatchObject({ budget: "task_tokens" });
    await expect(restarted.call(runId, "task_1", 2)).resolves.toBeDefined();
  });

  it("rejects invalid budgets before a run exists and leaves no residue", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50, maxRunUsd: 4, maxTaskTokens: 25, maxRunWallClockMinutes: 90 });

    for (const budgetTokens of [0, -1, 1.5]) {
      const error = await rejectionOf(fixture.createRun({ budgetTokens }));
      expect(error.code).toBe("CONFIG_ERROR");
      expect(error.message).toMatch(/budgetTokens must be a positive integer/);
    }
    for (const budgetUsd of [0, -1]) {
      const error = await rejectionOf(fixture.createRun({ budgetUsd }));
      expect(error.code).toBe("CONFIG_ERROR");
      expect(error.message).toMatch(/budgetUsd must be a positive number/);
    }

    await expect(fixture.service.handle("status", {})).resolves.toEqual([]);
    // Both flags present with exactly one ill-formed: each check has to fire on its own
    // dimension, not merely when the other dimension is absent.
    const mixedTokens = await rejectionOf(fixture.createRun({ budgetTokens: 1.5, budgetUsd: 1 }));
    expect(mixedTokens.code).toBe("CONFIG_ERROR");
    expect(mixedTokens.message).toMatch(/budgetTokens must be a positive integer/);
    const mixedUsd = await rejectionOf(fixture.createRun({ budgetTokens: 30, budgetUsd: -1 }));
    expect(mixedUsd.code).toBe("CONFIG_ERROR");
    expect(mixedUsd.message).toMatch(/budgetUsd must be a positive number/);

    // Infinity has to be refused before the budget check sees it: `Infinity > 0` is true, so
    // that check would pass it through and the run would carry no cap at all. The guard on the
    // persisted path is tested; this is the same hazard on the live one.
    const infiniteTokens = await rejectionOf(fixture.createRun({ budgetTokens: Number.POSITIVE_INFINITY }));
    expect(infiniteTokens.code).toBe("CONFIG_ERROR");
    expect(infiniteTokens.message).toMatch(/budgetTokens must be a number/);
    const infiniteUsd = await rejectionOf(fixture.createRun({ budgetUsd: Number.POSITIVE_INFINITY }));
    expect(infiniteUsd.code).toBe("CONFIG_ERROR");
    expect(infiniteUsd.message).toMatch(/budgetUsd must be a number/);

    // Every dimension, since a rejected budget must leave the whole configuration alone.
    expect(fixture.service.getConfig().budget).toEqual({
      maxRunTokens: 50,
      maxRunUsd: 4,
      maxAttemptTokens: null,
      maxTaskTokens: 25,
      maxRunWallClockMinutes: 90,
    });
    const runId = await fixture.createRun({});
    await callTimes(fixture, runId, 5);
    expect((await budgetErrorOf(fixture.call(runId))).details).toMatchObject({ limit: 50 });
  });

  it("still enforces each run's own override after a daemon restart", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    // A pair per iteration rather than one pair reused. Spend now survives a restart, so a reused
    // run carries the previous iteration's calls and would be exhausted before this one starts.
    // The subject is the touch order, not the run identity.
    const pairs = [];
    for (const _ of [0, 1]) {
      pairs.push({
        tight: await fixture.createRun({ budgetTokens: 1 }),
        loose: await fixture.createRun({ budgetTokens: 10_000 }),
      });
    }
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    // Both touch orders, each over its own restart: a resolver keyed by anything but the run,
    // or one caching the last override it saw, survives only one of the two.
    for (const [index, looseFirst] of [true, false].entries()) {
      const { tight, loose } = pairs[index]!;
      const restarted = fixture.restart();
      if (looseFirst) await callTimes(restarted, loose, 8);
      await callTimes(restarted, tight, 1);
      expect((await budgetErrorOf(restarted.call(tight))).details).toMatchObject({ limit: 1 });
      if (!looseFirst) await callTimes(restarted, loose, 8);
      await expect(restarted.call(loose)).resolves.toBeDefined();
      await restarted.service.close();
      services.splice(services.indexOf(restarted.service), 1);
    }
  });

  it("has the override in force on a tick that lands before metadata is written", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const observed: number[] = [];
    let created: string | null = null;
    fixture.service.engine.registerPhase("CREATED", (ctx) => {
      created = ctx.run.id;
      observed.push(ctx.config.budget.maxRunTokens ?? -1);
      return { status: "waiting" };
    });
    let ticked = false;
    let boundInWindow: Record<string, unknown> | null = null;
    vi.spyOn(Git.prototype, "createBranch").mockImplementationOnce(async function (
      this: Git,
      ...args: Parameters<Git["createBranch"]>
    ) {
      ticked = true;
      await fixture.service.engine.tick();
      // The contract registers limits before a run can be driven *or issue a model call*, so
      // the guard must bind here too. A resolver reading only persisted metadata finds none.
      const runId = created;
      if (runId !== null) {
        await callTimes(fixture, runId, 2);
        boundInWindow = (await budgetErrorOf(fixture.call(runId))).details;
      }
      return this.createBranch(...args);
    });

    await fixture.createRun({ budgetTokens: 20 });

    expect(ticked).toBe(true);
    expect(observed.length).toBeGreaterThan(0);
    expect(new Set(observed)).toEqual(new Set([20]));
    expect(boundInWindow).toMatchObject({ budget: "run_tokens", limit: 20 });
  });

  it("reports the same limits to C2 that the broker enforces, and records them as applied", async () => {
    // Every dimension configured finite. Two of them a run may never override, and against a
    // `null` configuration an assertion on those compares nothing to nothing.
    const fixture = await daemonFixture({ maxRunTokens: 50, maxRunUsd: 4, maxTaskTokens: 25, maxRunWallClockMinutes: 90 });
    const overridden = await fixture.createRun({ budgetTokens: 30 });
    const plain = await fixture.createRun({});
    // USD-only: pins the USD half of the agreement, and pins that a partial override leaves
    // the other dimension at its configured value rather than clearing it.
    const usdOnly = await fixture.createRun({ budgetUsd: 2 });

    await driveToConvergence(fixture, overridden);
    await driveToConvergence(fixture, plain);
    await driveToConvergence(fixture, usdOnly);

    // Every dimension, not a subset: MC5 makes only two of the four overridable, and C2 decides
    // exhaustion from all of them, so a widened override would be a decision defect here.
    const overriddenBudget = persistedSampleBudget(fixture, overridden);
    expect(overriddenBudget.limits).toEqual({ maxRunTokens: 30, maxRunUsd: 4, maxTaskTokens: 25, maxRunWallClockMinutes: 90 });
    expect(overriddenBudget.unusedCliMetadata).toEqual({ budgetTokens: 30, budgetUsd: null, applied: true });

    const plainBudget = persistedSampleBudget(fixture, plain);
    expect(plainBudget.limits).toEqual({ maxRunTokens: 50, maxRunUsd: 4, maxTaskTokens: 25, maxRunWallClockMinutes: 90 });
    expect(plainBudget.unusedCliMetadata).toEqual({ budgetTokens: null, budgetUsd: null, applied: false });

    // The same runs on the other surface, compared against what C2 reported rather than against
    // literals repeated here: agreement is the invariant, so it has to be read from one side and
    // checked on the other. `usdOnly` is the telling one -- its token cap is the dimension its
    // own override never named, and only the guard can say whether it survived.
    for (const [runId, calls] of [[overridden, 3], [plain, 5], [usdOnly, 5]] as const) {
      const reported = persistedSampleBudget(fixture, runId).limits.maxRunTokens;
      await callTimes(fixture, runId, calls);
      expect((await budgetErrorOf(fixture.call(runId))).details).toMatchObject({ budget: "run_tokens", limit: reported });
    }

    const usdOnlyBudget = persistedSampleBudget(fixture, usdOnly);
    expect(usdOnlyBudget.limits).toEqual({ maxRunUsd: 2, maxRunTokens: 50, maxTaskTokens: 25, maxRunWallClockMinutes: 90 });
    expect(usdOnlyBudget.unusedCliMetadata).toEqual({ budgetTokens: null, budgetUsd: 2, applied: true });
  });

  it("compares every dimension C2 reports against the guard, not only the token one", async () => {
    // The comparison above reads C2's token limit and requires the guard to refuse at exactly
    // that value. The other two dimensions are matched against literals instead -- and against
    // literals written in fixtures configured differently -- so a resolver that diverges on USD
    // or on the per-task cap reports one number to C2 and enforces another. What hides such a
    // resolver is the state of the dimensions it is not diverging on: the one fixture pairing a
    // partial override with a fully finite configuration is unpriced, so the guard's USD
    // dimension cannot bind there at all.
    const fixture = await daemonFixture({ maxRunTokens: 500, maxRunUsd: 4, maxTaskTokens: 30, maxRunWallClockMinutes: 90, costUsd: 0.5 });
    const usdOnly = await fixture.createRun({ budgetUsd: 2.25 });
    const tokenOnly = await fixture.createRun({ budgetTokens: 60 });
    const plain = await fixture.createRun({});

    await driveToConvergence(fixture, usdOnly);
    await driveToConvergence(fixture, tokenOnly);
    await driveToConvergence(fixture, plain);

    const usdOnlyLimits = persistedSampleBudget(fixture, usdOnly).limits;

    // Agreement between the two surfaces cannot see a resolution that is wrong on both of them,
    // because both read it from one place. So the number C2 reports is also pinned against what
    // the run asked for. A fraction is what makes that pin load-bearing: every other override in
    // this suite that meets a finite configured cap is an integer, and a resolver truncating one
    // would agree with itself on the wrong number.
    expect(usdOnlyLimits.maxRunUsd).toBe(2.25);

    // The per-task cap a partial override must leave alone, on the surface that enforces it and
    // not only on the one that reports it. The guard checks USD first and run tokens second, so
    // three task-named calls meet the 30-token task cap while staying inside this run's own $2.
    await callTimes(fixture, usdOnly, 3, "task_1");
    expect((await budgetErrorOf(fixture.call(usdOnly, "task_1"))).details)
      .toMatchObject({ budget: "task_tokens", limit: usdOnlyLimits.maxTaskTokens });

    // The same run's USD cap, which its own override did replace: a fresh task has no per-task
    // spend, so the next refusal on it can only come from the dimension under test.
    await callTimes(fixture, usdOnly, 2, "task_2");
    expect((await budgetErrorOf(fixture.call(usdOnly, "task_2"))).details)
      .toMatchObject({ budget: "run_usd", limit: usdOnlyLimits.maxRunUsd });

    // USD on a run that kept the configured cap rather than replacing it, since a divergence
    // could follow either polarity.
    const plainUsd = persistedSampleBudget(fixture, plain).limits.maxRunUsd;
    await callTimes(fixture, plain, 8);
    expect((await budgetErrorOf(fixture.call(plain))).details).toMatchObject({ budget: "run_usd", limit: plainUsd });

    // Tokens again, but on a priced run whose USD cap is finite and untouched: the token
    // comparison above runs unpriced, where a USD-conditioned divergence cannot show itself.
    const tokenOnlyTokens = persistedSampleBudget(fixture, tokenOnly).limits.maxRunTokens;
    await callTimes(fixture, tokenOnly, 6);
    expect((await budgetErrorOf(fixture.call(tokenOnly))).details).toMatchObject({ budget: "run_tokens", limit: tokenOnlyTokens });
  });

  it("invents no limit on a dimension no override may touch", async () => {
    // Every other fixture that reaches C2 configures the per-task and wall-clock caps finite, so
    // "equals the loaded configuration's value" has only ever been observed where there was a
    // value to equal. A merge that fills either of them in when the operator set none agrees with
    // every one of those checks. The wall-clock half is a decision and not only a report: an
    // invented deadline lands among the exhausted dimensions and stops a run on a cap nobody set,
    // so this observation boundary sits two minutes after the run was created.
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const overridden = await fixture.createRun({ budgetTokens: 30 });
    const plain = await fixture.createRun({});

    await driveToConvergence(fixture, overridden, 120_000);
    await driveToConvergence(fixture, plain, 120_000);

    const overriddenBudget = persistedSampleBudget(fixture, overridden);
    expect(overriddenBudget.limits)
      .toEqual({ maxRunTokens: 30, maxRunUsd: null, maxTaskTokens: null, maxRunWallClockMinutes: null });
    expect(overriddenBudget.exhaustedDimensions).toEqual([]);

    // The run that overrode nothing never reaches the merge at all, which separates "the merge
    // invented a limit" from "the configuration default is wrong".
    expect(persistedSampleBudget(fixture, plain).limits)
      .toEqual({ maxRunTokens: 50, maxRunUsd: null, maxTaskTokens: null, maxRunWallClockMinutes: null });
  });

  it("reports a run's own limits to C2 where the configuration set none, in the default runtime mode", async () => {
    // Two gaps meet here, both on C2's side of the merge, which is applied separately from the
    // tracker's. Every fixture reaching C2 configured the dimension the run then overrode, so a
    // merge overlaying a dimension only where there is already a finite value to replace reported
    // the configuration's `null` while the guard bound the run's own number. And every C2 sample
    // was taken for a run created with `runtime: "off"`, while `auto` is what the RPC handler and
    // the CLI default to, so a merge skipped for the default mode was invisible.
    const fixture = await daemonFixture({ maxRunTokens: null, maxRunUsd: null, costUsd: 0.5 });
    const runId = await fixture.createRun({ budgetTokens: 1_000, budgetUsd: 2.5, runtime: "auto" });

    await driveToConvergence(fixture, runId);

    const sample = persistedSampleBudget(fixture, runId);
    const limits = sample.limits;
    expect(limits).toEqual({ maxRunTokens: 1_000, maxRunUsd: 2.5, maxTaskTokens: null, maxRunWallClockMinutes: null });
    // The two fields of one snapshot are resolved at different sites from different objects, and
    // `applied` is inferred from the flags being present rather than from the limits that were
    // merged -- so a merge that dropped the override would still report itself as applied here.
    expect(sample.unusedCliMetadata).toEqual({ budgetTokens: 1_000, budgetUsd: 2.5, applied: true });

    // Still a comparison and not only a report: the guard has to refuse at the number C2 gave.
    // The token cap is far out of reach, so USD is the only dimension that can produce this. The
    // override is fractional because C2's own copy of the merge had only ever been observed with
    // an integer where the configuration set nothing, so a truncation there was invisible too.
    await callTimes(fixture, runId, 5);
    expect((await budgetErrorOf(fixture.call(runId))).details)
      .toMatchObject({ budget: "run_usd", limit: limits.maxRunUsd });
  });

  it("does not refuse a priced run below its own USD cap", async () => {
    // Every other USD check gives calls a cost that divides the cap, so observed spend only ever
    // lands exactly on the cap or exactly one call short of it, and a guard firing anywhere
    // inside that last interval is invisible. This cost does not divide this cap: the call made
    // at $1.20 against a $1.25 cap has to be allowed, and only the spend that meets the cap may
    // refuse. The token dimension cannot hide the same thing -- token spends are integers and a
    // token budget is validated as one -- so this is the USD half of "it must not throw below N".
    const fixture = await daemonFixture({ maxRunUsd: null, costUsd: 0.6 });
    const runId = await fixture.createRun({ budgetUsd: 1.25 });

    await callTimes(fixture, runId, 3);
    expect((await budgetErrorOf(fixture.call(runId))).details).toMatchObject({ budget: "run_usd", limit: 1.25 });
  });

  it("carries a fractional USD budget across a restart", async () => {
    // The persisted-budget guard must not demand an integer here: USD budgets are not, and
    // rejecting one downgrades a valid run to the daemon-wide limit without saying so. One
    // budget sits below a dollar, because "positive" and "at least one" agree everywhere else.
    const fixture = await daemonFixture({ maxRunUsd: null, costUsd: 0.5 });
    const runId = await fixture.createRun({ budgetUsd: 1.25 });
    const subOne = await fixture.createRun({ budgetUsd: 0.5 });
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const restarted = fixture.restart();
    await callTimes(restarted, runId, 3);
    expect((await budgetErrorOf(restarted.call(runId))).details).toMatchObject({ budget: "run_usd", limit: 1.25 });

    await callTimes(restarted, subOne, 1);
    expect((await budgetErrorOf(restarted.call(subOne))).details).toMatchObject({ budget: "run_usd", limit: 0.5 });
  });

  it("carries a fractional USD budget across a restart against a finite configured cap", async () => {
    // The restart above configures no USD cap at all, so it cannot see a truncation that only
    // happens when there is a configured value to fall back to -- and the read-back path resolves
    // a run's overrides separately from the path that created it, so closing this on the live
    // surface alone leaves it open here. Both polarities: a fraction below the configured cap and
    // one above it truncate to different wrong numbers.
    const fixture = await daemonFixture({ maxRunUsd: 4, costUsd: 0.5 });
    const lowered = await fixture.createRun({ budgetUsd: 1.25 });
    const raised = await fixture.createRun({ budgetUsd: 4.5 });
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const restarted = fixture.restart();
    await callTimes(restarted, lowered, 3);
    expect((await budgetErrorOf(restarted.call(lowered))).details).toMatchObject({ budget: "run_usd", limit: 1.25 });

    await callTimes(restarted, raised, 9);
    expect((await budgetErrorOf(restarted.call(raised))).details).toMatchObject({ budget: "run_usd", limit: 4.5 });
  });

  it("reports a raised cap to C2 as raised, not clamped to the configured one", async () => {
    // The lowering case cannot tell replacement from clamping: both land on the same number.
    // Both dimensions are raised, since a clamp confined to either one would otherwise pass.
    const fixture = await daemonFixture({ maxRunTokens: 50, maxRunUsd: 4, maxTaskTokens: 25, maxRunWallClockMinutes: 90 });
    const raised = await fixture.createRun({ budgetTokens: 100, budgetUsd: 9 });

    await driveToConvergence(fixture, raised);

    const budget = persistedSampleBudget(fixture, raised);
    expect(budget.limits).toEqual({ maxRunTokens: 100, maxRunUsd: 9, maxTaskTokens: 25, maxRunWallClockMinutes: 90 });
    expect(budget.unusedCliMetadata).toEqual({ budgetTokens: 100, budgetUsd: 9, applied: true });
  });

  it("falls back to the daemon-wide limit when a run's persisted budget is corrupt", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    // "lots" reaches the guard as a NaN comparison and never fires, so the run would carry no
    // cap at all; the rest would bind a nonsense cap of their own. Every one must give way to
    // the daemon's, and none of these can be written by `handle("run", …)` in the first place.
    // `"{ not json"` is last: unreadable, not merely wrong.
    const shapes: unknown[] = ["lots", 0, -5, 1.5, null, "UNREADABLE"];
    // One run per shape. Spend survives a restart now, so reusing a run would exhaust the
    // daemon-wide cap during the second shape and stop observing the fallback at all.
    const runs = await Promise.all(shapes.map(async () => fixture.createRun({ budgetTokens: 10_000 })));
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    for (const [index, budgetTokens] of shapes.entries()) {
      const runId = runs[index]!;
      const facade = join(fixture.home, "runs", runId, "facade.json");
      const metadata = JSON.parse(readFileSync(facade, "utf8")) as Record<string, unknown>;
      expect(metadata["budgetTokens"]).toBe(10_000);
      writeFileSync(
        facade,
        budgetTokens === "UNREADABLE" ? "{ not json" : JSON.stringify({ ...metadata, budgetTokens }),
      );
      const restarted = fixture.restart();
      await callTimes(restarted, runId, 5);
      expect((await budgetErrorOf(restarted.call(runId))).details).toMatchObject({ limit: 50 });
      await restarted.service.close();
      services.splice(services.indexOf(restarted.service), 1);
    }
  });

  it("falls back to the daemon-wide USD limit when a run's persisted USD budget is corrupt", async () => {
    // The token twin of this runs above. The guard treats the two dimensions differently on
    // purpose -- a fractional USD budget is legal -- so each needs driving on its own.
    const fixture = await daemonFixture({ maxRunTokens: null, maxRunUsd: 4, costUsd: 0.5 });
    // Written as raw JSON text, because `1e999` overflows to Infinity on parse and cannot be
    // produced by stringifying a value. For tokens the integer check rejects it; for USD, where
    // fractions are legal, the finiteness check is the only thing standing between an
    // overflowing literal and a run with no USD cap at all.
    const literals = ['"lots"', "0", "-5", "null", "1e999"];
    // One run per literal, for the reason given in the token twin above.
    const runs = await Promise.all(literals.map(async () => fixture.createRun({ budgetUsd: 1 })));
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    for (const [index, literal] of literals.entries()) {
      const runId = runs[index]!;
      const facade = join(fixture.home, "runs", runId, "facade.json");
      const metadata = JSON.parse(readFileSync(facade, "utf8")) as Record<string, unknown>;
      expect(metadata["budgetUsd"]).toBe(1);
      writeFileSync(facade, JSON.stringify({ ...metadata, budgetUsd: "PLACEHOLDER" }).replace('"PLACEHOLDER"', literal));
      const restarted = fixture.restart();
      await callTimes(restarted, runId, 8);
      expect((await budgetErrorOf(restarted.call(runId))).details).toMatchObject({ budget: "run_usd", limit: 4 });
      await restarted.service.close();
      services.splice(services.indexOf(restarted.service), 1);
    }
  });

  it("keeps the sound half of a run's persisted budget when the other half is corrupt", async () => {
    const fixture = await daemonFixture({ maxRunTokens: null, maxRunUsd: 4, costUsd: 0.5 });
    // One run per polarity. The previous shape reused a single run and corrupted its facade twice;
    // with spend surviving a restart the second polarity inherited the first's calls. It also made
    // the second scenario read as an anomaly, because the second write restores `budgetUsd: 1` from
    // the original metadata and that `limit: 1` looked unexplained. See `docs/ledger/P1.3.md`.
    const corruptUsd = await fixture.createRun({ budgetTokens: 30, budgetUsd: 1 });
    const corruptTokens = await fixture.createRun({ budgetTokens: 30, budgetUsd: 1 });
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const facadeOf = (runId: string): string => join(fixture.home, "runs", runId, "facade.json");
    const metadataOf = (runId: string): Record<string, unknown> =>
      JSON.parse(readFileSync(facadeOf(runId), "utf8")) as Record<string, unknown>;

    // Discarding the whole budget would leave this run on the daemon's `null` token cap, so
    // the throw that arrives says which half survived.
    writeFileSync(facadeOf(corruptUsd), JSON.stringify({ ...metadataOf(corruptUsd), budgetUsd: "lots" }));
    const restarted = fixture.restart();
    await callTimes(restarted, corruptUsd, 3);
    expect((await budgetErrorOf(restarted.call(corruptUsd))).details).toMatchObject({ budget: "run_tokens", limit: 30 });
    await restarted.service.close();
    services.splice(services.indexOf(restarted.service), 1);

    // The other polarity, since dropping the sound half is a per-dimension decision and either
    // side of it can be got wrong on its own.
    writeFileSync(facadeOf(corruptTokens), JSON.stringify({ ...metadataOf(corruptTokens), budgetTokens: "lots" }));
    const reversed = fixture.restart();
    await callTimes(reversed, corruptTokens, 2);
    expect((await budgetErrorOf(reversed.call(corruptTokens))).details).toMatchObject({ budget: "run_usd", limit: 1 });
  });

  it("reports a recovered run's own limits to C2, not only to the broker", async () => {
    // Everything C2 sees is otherwise sampled in the process that created the run, so a config
    // resolved from memory alone would satisfy the rest of the suite.
    const fixture = await daemonFixture({ maxRunTokens: 50, maxRunUsd: 4, maxTaskTokens: 25, maxRunWallClockMinutes: 90 });
    const recovered = await fixture.createRun({ budgetTokens: 30 });
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const restarted = fixture.restart();
    await driveToConvergence(restarted, recovered);

    const budget = persistedSampleBudget(restarted, recovered);
    expect(budget.limits).toEqual({ maxRunTokens: 30, maxRunUsd: 4, maxTaskTokens: 25, maxRunWallClockMinutes: 90 });
    expect(budget.unusedCliMetadata).toEqual({ budgetTokens: 30, budgetUsd: null, applied: true });
  });

  it("keeps a recovered run's override when its facade predates the runtime field", async () => {
    // `runConfig` resolves a run's mode and its budget from the same file, and the budget merge
    // sits just past the mode branch. A facade carrying a budget and no `runtime` makes
    // `persistedRuntimeMode` return null, so that branch is skipped entirely -- and that is the
    // shape of every facade written before the runtime mode was persisted, which is what an
    // upgraded daemon finds when it restarts onto runs it did not create. Nothing else in this
    // file reaches it: every other facade here was written by the current handler, which always
    // stores a mode.
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const runId = await fixture.createRun({ budgetTokens: 30 });
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const facade = join(fixture.home, "runs", runId, "facade.json");
    const { runtime, ...legacy } = JSON.parse(readFileSync(facade, "utf8")) as Record<string, unknown>;
    expect(runtime).toBeDefined();
    writeFileSync(facade, JSON.stringify(legacy));

    const restarted = fixture.restart();
    await driveToConvergence(restarted, runId);
    expect(persistedSampleBudget(restarted, runId).limits.maxRunTokens).toBe(30);

    await callTimes(restarted, runId, 3);
    expect((await budgetErrorOf(restarted.call(runId))).details)
      .toMatchObject({ budget: "run_tokens", limit: 30 });
  });

  it("invents no limit for a recovered run either", async () => {
    // The live version of this runs above, but a recovered run resolves its own budget by a
    // different route -- read back from the facade rather than held in memory since creation --
    // and the only recovered C2 fixture configures all four dimensions finite, so the crossing
    // was empty. The consequence is the same decision rather than a report: an invented deadline
    // lands among the exhausted dimensions and stops a run nobody capped.
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const recovered = await fixture.createRun({ budgetTokens: 30 });
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const restarted = fixture.restart();
    await driveToConvergence(restarted, recovered, 120_000);

    const budget = persistedSampleBudget(restarted, recovered);
    expect(budget.limits)
      .toEqual({ maxRunTokens: 30, maxRunUsd: null, maxTaskTokens: null, maxRunWallClockMinutes: null });
    expect(budget.exhaustedDimensions).toEqual([]);
  });

  it("keeps recovered runs' limits apart at C2, not only at the broker", async () => {
    // The broker half of this is pinned with two runs and both touch orders. C2's half has only
    // ever sampled a single recovered run, so a resolution answering every recovered run with
    // the first one it saw -- or with the most recent -- handed a run its sibling's cap.
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const tight = await fixture.createRun({ budgetTokens: 30 });
    const loose = await fixture.createRun({ budgetTokens: 80 });
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const restarted = fixture.restart();
    await driveToConvergence(restarted, loose);
    await driveToConvergence(restarted, tight);
    expect(persistedSampleBudget(restarted, loose).limits.maxRunTokens).toBe(80);
    expect(persistedSampleBudget(restarted, tight).limits.maxRunTokens).toBe(30);

    // Sampled once more after its sibling, so answering with the most recent resolution is
    // caught as well as answering with the first.
    await driveToConvergence(restarted, loose);
    expect(persistedSampleBudget(restarted, loose).limits.maxRunTokens).toBe(80);
  });

  it("reports an override that matches the configured cap as applied", async () => {
    // Enforcement cannot tell this run from one that overrode nothing -- both refuse at 50 -- so
    // the report is the only surface where the difference exists. Treating an equal override as
    // no override says `applied: false` about a flag the operator did pass, which is this task's
    // original defect one field over.
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const equal = await fixture.createRun({ budgetTokens: 50 });

    await driveToConvergence(fixture, equal);

    const sample = persistedSampleBudget(fixture, equal);
    expect(sample.limits.maxRunTokens).toBe(50);
    expect(sample.unusedCliMetadata).toEqual({ budgetTokens: 50, budgetUsd: null, applied: true });
  });

  it("lets a run's own cap exhaust C2, not only the configured one", async () => {
    // Every other check of the exhausted set requires it empty, which a resolution that never
    // counts an overridden run as exhausted satisfies everywhere. Stopping a run is what the
    // sample is for: such a run would refuse its own calls at the guard and still never reach
    // BUDGET_STOP. Nothing is configured, so only the run's own cap can produce this.
    const fixture = await daemonFixture({ maxRunTokens: null });
    const runId = await fixture.createRun({ budgetTokens: 30 });

    await callTimes(fixture, runId, 3);
    await driveToConvergence(fixture, runId);

    expect(persistedSampleBudget(fixture, runId).exhaustedDimensions).toEqual(["run_tokens"]);
  });

  it("keeps a run's runtime mode when it also carries a budget override", async () => {
    // The two per-run settings compose on one config. Budget checks all run with the mode off
    // and mode checks all run without a budget, so only a run carrying both can see them meet.
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const observed: { mode: string; tokens: number | null }[] = [];
    fixture.service.engine.registerPhase("CREATED", (ctx) => {
      observed.push({ mode: ctx.config.runtimeValidation.mode, tokens: ctx.config.budget.maxRunTokens });
      return { status: "waiting" };
    });

    await fixture.createRun({ budgetTokens: 20, runtime: "required" });

    expect(observed).toContainEqual({ mode: "required", tokens: 20 });
  });

  it("leaves the loaded config instance shared and untouched", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const before = fixture.service.getConfig();
    const runId = await fixture.createRun({ budgetTokens: 20 });
    await fixture.call(runId);

    expect(fixture.service.getConfig()).toBe(before);
    expect(fixture.service.getConfig()).toBe(fixture.service.productionComposition().config);
    expect(before.budget.maxRunTokens).toBe(50);
  });

  /**
   * Finding 21. A corrupt facade used to downgrade a run silently. It still falls back, per
   * dimension, but now it says so — once per run, not once per resolution.
   */
  describe("run.settings_fallback", () => {
    it("emits one event for an unreadable facade, however many times the run resolves", async () => {
      const fixture = await daemonFixture({ maxRunTokens: 50 });
      const runId = await fixture.createRun({ budgetTokens: 30 });
      await fixture.service.close();
      services.splice(services.indexOf(fixture.service), 1);

      writeFileSync(join(fixture.home, "runs", runId, "facade.json"), "{ not json");
      const restarted = fixture.restart();
      await callTimes(restarted, runId, 5);
      await restarted.service.engine.tick();

      const events = fallbackEvents(restarted, runId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ reason: "facade_unreadable", requestedMode: null });
      // The daemon-wide cap is in force, which is the fallback the event is reporting.
      expect((await budgetErrorOf(restarted.call(runId))).details).toMatchObject({ limit: 50 });
    });

    it("names the mode it kept when only a budget half is corrupt", async () => {
      const fixture = await daemonFixture({ maxRunTokens: null, maxRunUsd: 4, costUsd: 0.5 });
      const runId = await fixture.createRun({ budgetTokens: 30, budgetUsd: 1, runtime: "required" });
      await fixture.service.close();
      services.splice(services.indexOf(fixture.service), 1);

      const facade = join(fixture.home, "runs", runId, "facade.json");
      const metadata = JSON.parse(readFileSync(facade, "utf8")) as Record<string, unknown>;
      writeFileSync(facade, JSON.stringify({ ...metadata, budgetUsd: "lots" }));

      const restarted = fixture.restart();
      await callTimes(restarted, runId, 3);

      const events = fallbackEvents(restarted, runId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        reason: "budget_usd_invalid",
        requestedMode: "required",
        effectiveMode: "required",
      });
      // The sound half still binds: the event records what was discarded, not more.
      expect((await budgetErrorOf(restarted.call(runId))).details).toMatchObject({ budget: "run_tokens", limit: 30 });
    });

    it("reports an unparseable runtime with a null requested mode", async () => {
      const fixture = await daemonFixture({ maxRunTokens: 50 });
      const runId = await fixture.createRun({ budgetTokens: 30 });
      await fixture.service.close();
      services.splice(services.indexOf(fixture.service), 1);

      const facade = join(fixture.home, "runs", runId, "facade.json");
      const metadata = JSON.parse(readFileSync(facade, "utf8")) as Record<string, unknown>;
      writeFileSync(facade, JSON.stringify({ ...metadata, runtime: "sometimes" }));

      const restarted = fixture.restart();
      await callTimes(restarted, runId, 1);

      const events = fallbackEvents(restarted, runId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ reason: "runtime_invalid", requestedMode: null });
      // The budget half was sound and is untouched by the runtime half falling back.
      await callTimes(restarted, runId, 2);
      expect((await budgetErrorOf(restarted.call(runId))).details).toMatchObject({ limit: 30 });
    });

    it("joins every reason when more than one field is corrupt", async () => {
      const fixture = await daemonFixture({ maxRunTokens: 50, maxRunUsd: 4, costUsd: 0.5 });
      const runId = await fixture.createRun({ budgetTokens: 30, budgetUsd: 1 });
      await fixture.service.close();
      services.splice(services.indexOf(fixture.service), 1);

      const facade = join(fixture.home, "runs", runId, "facade.json");
      const metadata = JSON.parse(readFileSync(facade, "utf8")) as Record<string, unknown>;
      writeFileSync(facade, JSON.stringify({ ...metadata, runtime: "sometimes", budgetTokens: 0, budgetUsd: "lots" }));

      const restarted = fixture.restart();
      await callTimes(restarted, runId, 1);

      expect(fallbackEvents(restarted, runId)[0]).toMatchObject({
        reason: "runtime_invalid,budget_tokens_invalid,budget_usd_invalid",
      });
    });

    it("is a known event type, so isKnownEventType and every consumer of it agree", () => {
      expect(isKnownEventType("run.settings_fallback")).toBe(true);
    });

    it("says nothing when the facade is sound", async () => {
      const fixture = await daemonFixture({ maxRunTokens: 50 });
      const runId = await fixture.createRun({ budgetTokens: 30 });
      await fixture.service.close();
      services.splice(services.indexOf(fixture.service), 1);

      const restarted = fixture.restart();
      await callTimes(restarted, runId, 2);
      await restarted.service.engine.tick();

      expect(fallbackEvents(restarted, runId)).toEqual([]);
    });
  });

  /**
   * `unusedCliMetadata` records whether the operator asked, which resolved limits cannot express:
   * an override equal to the configured cap resolves to the same limits as no override at all.
   */
  it("distinguishes an override that matches the configured cap from no override", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50, maxRunUsd: 4 });
    const asked = await fixture.createRun({ budgetTokens: 50 });
    const silent = await fixture.createRun({});

    await driveToConvergence(fixture, asked);
    await driveToConvergence(fixture, silent);

    expect(persistedSampleBudget(fixture, asked).unusedCliMetadata)
      .toEqual({ budgetTokens: 50, budgetUsd: null, applied: true });
    expect(persistedSampleBudget(fixture, silent).unusedCliMetadata)
      .toEqual({ budgetTokens: null, budgetUsd: null, applied: false });
    expect(persistedSampleBudget(fixture, asked).limits.maxRunTokens)
      .toBe(persistedSampleBudget(fixture, silent).limits.maxRunTokens);
  });
});

function fallbackEvents(fixture: Fixture, runId: string): Record<string, unknown>[] {
  return fixture.service.store.events
    .list(runId, { types: ["run.settings_fallback"] })
    .map((event) => event.payload);
}

interface Fixture {
  service: DaemonService;
  home: string;
  repoDir: string;
  gate: Gate;
  createRun: (budget: { budgetTokens?: number; budgetUsd?: number; runtime?: string }) => Promise<string>;
  call: (runId: string, taskId?: string, taskAttempt?: number) => Promise<ModelCallRecord>;
  restart: () => Fixture;
}

interface Gate {
  parkRun: (runId: string) => void;
  arrived: Promise<void>;
  release: () => void;
}

/**
 * Puts a real daemon run into CONVERGENCE_CHECK with an observation boundary, then drives the
 * engine so the sample comes from the registered production driver rather than a hand-built one.
 */
async function driveToConvergence(fixture: Fixture, runId: string, observedAfterMs = 5): Promise<void> {
  const store = fixture.service.productionComposition().store;
  const now = fixture.service.productionComposition().clock.now();
  const run = store.repos.runs.get(runId)!;
  const system = { kind: "system" as const };
  // No coding tasks, so the anti-fake DONE gate passes and the driver reaches the sample;
  // no clean rounds, so it does not short-circuit to DONE either.
  store.events.append([
    {
      id: id("evt", now + 4),
      runId,
      ts: now + 4,
      type: "run.phase_changed",
      payload: { run: { ...run, phase: "CONVERGENCE_CHECK", updatedAt: now + 4 } },
      causedBy: [],
      actor: system,
      artifacts: [],
    },
    {
      id: id("evt", now + observedAfterMs),
      runId,
      ts: now + observedAfterMs,
      type: "budget.evaluated",
      payload: { kind: "wall_clock", dueAt: now, observedAt: now + observedAfterMs },
      causedBy: [],
      actor: system,
      artifacts: [],
    },
  ]);
  await fixture.service.engine.tickRun(runId);
}

function persistedSampleBudget(fixture: Fixture, runId: string): PathologyBudgetSnapshot {
  const events = fixture.service.productionComposition().store.events.list(runId, { types: ["pathology.sample"] });
  expect(events.length).toBeGreaterThan(0);
  return (events.at(-1)!.payload["sample"] as PathologySample).budget;
}

/** Each scripted call costs 10 tokens, so a threshold is always a whole number of calls. */
async function callTimes(fixture: Fixture, runId: string, times: number, taskId?: string): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await expect(fixture.call(runId, taskId)).resolves.toBeDefined();
  }
}

/** The rejection itself, so a check can name the code and not only the message. */
async function rejectionOf(promise: Promise<unknown>): Promise<PolishError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PolishError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

async function budgetErrorOf(promise: Promise<unknown>): Promise<PolishError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PolishError && isBudgetError(error)) return error;
    throw error;
  }
  throw new Error("expected a budget error");
}

/** Delegates to a scripted provider, but can suspend one run's call inside `complete`. */
class GatedProvider implements ProviderAdapter {
  readonly id: string;
  readonly kind = "scripted";
  readonly concurrency = null;
  private parkedRunId: string | null = null;
  private announce: () => void = () => undefined;
  private open: () => void = () => undefined;
  readonly arrived: Promise<void>;
  private readonly released: Promise<void>;

  constructor(private readonly inner: ScriptedProvider) {
    this.id = inner.id;
    this.arrived = new Promise<void>((resolve) => {
      this.announce = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  gate(): Gate {
    return {
      parkRun: (runId) => {
        this.parkedRunId = runId;
      },
      arrived: this.arrived,
      release: () => {
        this.open();
      },
    };
  }

  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }

  health(): Promise<ProviderHealth> {
    return this.inner.health();
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.parkedRunId === request.metadata.runId) {
      this.parkedRunId = null;
      this.announce();
      await this.released;
    }
    return this.inner.complete(request);
  }
}

async function daemonFixture(options: {
  maxRunTokens?: number | null;
  maxRunUsd?: number | null;
  maxTaskTokens?: number | null;
  maxRunWallClockMinutes?: number | null;
  costUsd?: number;
}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "polish-b8-budget-"));
  dirs.push(dir);
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "b8-fixture", scripts: {} }));
  const git = await Git.init(repoDir);
  await git.commitAll("init");

  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const limits = [
    options.maxRunTokens === undefined || options.maxRunTokens === null ? [] : [`maxRunTokens = ${options.maxRunTokens}`],
    options.maxRunUsd === undefined || options.maxRunUsd === null ? [] : [`maxRunUsd = ${options.maxRunUsd}`],
    options.maxTaskTokens === undefined || options.maxTaskTokens === null ? [] : [`maxTaskTokens = ${options.maxTaskTokens}`],
    options.maxRunWallClockMinutes === undefined || options.maxRunWallClockMinutes === null
      ? []
      : [`maxRunWallClockMinutes = ${options.maxRunWallClockMinutes}`],
  ].flat();
  writeFileSync(join(home, "polish.toml"), `[budget]\n${limits.join("\n")}\n`);

  return buildFixture(dir, home, repoDir, options.costUsd ?? null);
}

function buildFixture(dir: string, home: string, repoDir: string, costUsd: number | null): Fixture {
  const scripted = new ScriptedProvider(
    "scripted",
    [
      { name: "worker", capabilities: FAKE_CAPABILITIES.frontier },
      { name: "planner", capabilities: FAKE_CAPABILITIES.strong },
    ],
    // 10 tokens per call keeps every threshold in the tests a whole number of calls.
    { fallback: { kind: "reply", content: "ok", usage: { inputTokens: 10, outputTokens: 0, costUsd } } },
  );
  const provider = new GatedProvider(scripted);
  const service = new DaemonService({
    home,
    clock: new FakeClock(1_700_000_000_000),
    providers: [provider],
    tickMs: 1,
  });
  services.push(service);

  const fixture: Fixture = {
    service,
    home,
    repoDir,
    gate: provider.gate(),
    createRun: async (budget) => {
      const run = (await service.handle("run", { project: repoDir, mission: "noop", runtime: "off", ...budget })) as { id: string };
      return run.id;
    },
    call: (runId, taskId, taskAttempt) =>
      service.productionComposition().broker.complete({
        model: { provider: "scripted", model: "worker" },
        messages: [{ role: "user", content: "hello" }],
        metadata: {
          runId,
          purpose: "test",
          role: "worker",
          ...(taskId === undefined ? {} : { taskId }),
          ...(taskAttempt === undefined ? {} : { taskAttempt }),
        },
      }),
    restart: () => buildFixture(dir, home, repoDir, costUsd),
  };
  return fixture;
}
