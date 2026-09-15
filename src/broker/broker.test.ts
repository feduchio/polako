import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_CAPABILITIES, ScriptedProvider, reply } from "../providers/scripted.js";
import { RecordReplayProvider } from "../providers/recordReplay.js";
import { OpenAICompatProvider, inferFamily, inferTier, type FetchLike } from "../providers/openaiCompat.js";
import { GroqProvider } from "../providers/groq.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { ModelBroker } from "./broker.js";
import { ModelCatalog } from "./catalog.js";
import { BudgetTracker, QuotaTracker, isBudgetError } from "./quota.js";
import { ModelRouter } from "./router.js";
import { SecretStore, parseDotenv } from "./secrets.js";
import { ProviderError, type CompletionRequest } from "./types.js";
import { DISABLED_REASONING, EMPIRICAL_SCORE_RESPONSE_SCHEMA } from "./responseSchemas.js";

const NOW = 1_700_000_000_000;

function req(runId: string, model: string, provider = "p1", content = "hello"): CompletionRequest {
  return { model: { provider, model }, messages: [{ role: "user", content }], metadata: { runId, purpose: "test", role: "worker" } };
}

/** Would one more call of this estimated cost be admitted right now? */
function tryAdmit(budget: BudgetTracker, runId: string, estimatedUsd: number): boolean {
  try {
    budget.admit(runId, estimatedUsd)();
    return true;
  } catch (error) {
    if (isBudgetError(error)) return false;
    throw error;
  }
}

describe("ModelBroker", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;
  let provider: ScriptedProvider;
  let catalog: ModelCatalog;
  let budget: BudgetTracker;
  let broker: ModelBroker;
  const runId = id("run");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "polish-broker-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(NOW);
    provider = new ScriptedProvider("p1", [
      { name: "big", capabilities: FAKE_CAPABILITIES.frontier },
      { name: "mid", capabilities: FAKE_CAPABILITIES.strong },
    ]);
    catalog = new ModelCatalog();
    catalog.register(provider);
    await catalog.refresh();
    budget = new BudgetTracker({ maxRunUsd: 1, maxRunTokens: 1000, maxTaskTokens: null });
    broker = new ModelBroker({
      store,
      clock,
      catalog,
      quota: new QuotaTracker(clock, { concurrency: 2, rpm: null }),
      budget,
      secrets: SecretStore.fromValues({ OPENROUTER_API_KEY: "sk-supersecret-value" }),
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      jitter: () => 1,
    });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records every call as a model.call event with redacted request/response artifacts and updates stats", async () => {
    provider.script("big", [{ kind: "reply", content: "the key is sk-supersecret-value", usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 } }]);
    const rec = await broker.complete(req(runId, "big", "p1", "use sk-supersecret-value please"));
    expect(rec.response.message.content).toContain("sk-supersecret-value");
    const events = store.events.list(runId, { types: ["model.call"] });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ ok: true, attempts: 1, usage: { inputTokens: 100, outputTokens: 50 } });
    for (const a of events[0]!.artifacts) {
      const text = store.artifacts.getText(a.sha256);
      expect(text).not.toContain("sk-supersecret-value");
      expect(text).toContain("<redacted:OPENROUTER_API_KEY>");
    }
    expect(catalog.get({ provider: "p1", model: "big" })?.stats.calls).toBe(1);
    expect(budget.snapshot(runId)).toMatchObject({ runUsd: 0.01, runTokens: 150 });
    expect(store.events.list(runId, { types: ["model.call_started"] })).toHaveLength(1);
    expect(store.events.list(runId, { types: ["model.call"] })[0]?.payload["callId"]).toBe(
      store.events.list(runId, { types: ["model.call_started"] })[0]?.payload["callId"],
    );
  });

  it("holds a reservation across the provider call and releases it after the cost is recorded", async () => {
    // The catalogue prices this model, so the request determines an upper bound before the call.
    catalog.upsert({
      ref: { provider: "p1", model: "mid" },
      displayName: "mid",
      capabilities: { ...FAKE_CAPABILITIES.strong, inputCostPerM: 100, outputCostPerM: 100, maxOutputTokens: 1000 },
      source: "provider",
    });
    let admittedDuringCall: boolean | null = null;
    provider.script("mid", [{
      kind: "fn",
      fn: () => {
        // Inside the provider call: nothing is recorded yet, so only the reservation can refuse.
        // The estimate here is 1000 output tokens at $100/M = $0.1, against the run's $1 limit.
        admittedDuringCall = tryAdmit(budget, runId, 0.95);
        return reply("ok", 10, 5, 0.0001);
      },
    }]);
    await broker.complete({ ...req(runId, "mid"), maxTokens: 1000 });
    expect(admittedDuringCall).toBe(false);
    expect(budget.snapshot(runId).runUsd).toBe(0.0001);
    // Released: the run is charged what the call cost, not what it might have cost.
    expect(tryAdmit(budget, runId, 0.95)).toBe(true);
  });

  it("takes a reservation for every provider invocation, not one for the call", async () => {
    catalog.upsert({
      ref: { provider: "p1", model: "mid" },
      displayName: "mid",
      capabilities: { ...FAKE_CAPABILITIES.strong, inputCostPerM: 0, outputCostPerM: 100, maxOutputTokens: 1000 },
      source: "provider",
    });
    const admissible: boolean[] = [];
    provider.script("mid", [
      { kind: "fn", fn: () => { admissible.push(tryAdmit(budget, runId, 0.85)); throw new ProviderError("p1", "server", "1"); } },
      { kind: "fn", fn: () => { admissible.push(tryAdmit(budget, runId, 0.85)); throw new ProviderError("p1", "server", "2"); } },
      { kind: "fn", fn: () => { admissible.push(tryAdmit(budget, runId, 0.85)); return reply("ok", 10, 5, 0.001); } },
    ]);
    // Each attempt reserves $0.1 against the run's $1 limit; a failed attempt records no usage, so
    // one hold for the whole call would leave the second and third invocations unpriced.
    const p = broker.complete({ ...req(runId, "mid"), maxTokens: 1000 });
    await clock.advance(100);
    await clock.advance(200);
    await p;
    // Holds accumulate 0.1, 0.2, 0.3, so a $0.85 call fits beside the first and not beside the
    // later ones. One hold for the whole call would leave all three admissible.
    expect(admissible).toEqual([true, false, false]);
    expect(tryAdmit(budget, runId, 0.85)).toBe(true);
  });

  it("closes the call with a terminal event when a retry cannot be admitted", async () => {
    catalog.upsert({
      ref: { provider: "p1", model: "mid" },
      displayName: "mid",
      capabilities: { ...FAKE_CAPABILITIES.strong, inputCostPerM: 0, outputCostPerM: 100, maxOutputTokens: 1000 },
      source: "provider",
    });
    // Each attempt reserves $0.6 of a $1 limit, so the second cannot be admitted.
    provider.script("mid", [
      { kind: "error", error: new ProviderError("p1", "server", "1") },
      { kind: "reply", content: "unreachable" },
    ]);
    const call = broker.complete({ ...req(runId, "mid"), maxTokens: 6000 });
    const settled = call.then(() => null).catch((error: unknown) => error);
    await clock.advance(100);
    const error = await settled;
    expect(isBudgetError(error)).toBe(true);
    expect(store.events.list(runId, { types: ["model.call_started"] })).toHaveLength(1);
    // A started call with no terminal event is one no report, cost query or operator can account for.
    expect(store.events.list(runId, { types: ["model.call"] })).toHaveLength(1);
    expect(store.events.list(runId, { types: ["model.call"] })[0]?.payload["ok"]).toBe(false);
  });

  it("releases the reservation when the provider call fails", async () => {
    catalog.upsert({
      ref: { provider: "p1", model: "mid" },
      displayName: "mid",
      capabilities: { ...FAKE_CAPABILITIES.strong, inputCostPerM: 100, outputCostPerM: 100, maxOutputTokens: 1000 },
      source: "provider",
    });
    provider.script("mid", [{ kind: "error", error: new ProviderError("p1", "bad_request", "no") }]);
    await expect(broker.complete({ ...req(runId, "mid"), maxTokens: 1000 })).rejects.toThrow(ProviderError);
    expect(tryAdmit(budget, runId, 0.95)).toBe(true);
  });

  // R1. Retrying an exhausted account allowance is more calls that cannot succeed: its backoff is
  // milliseconds and the allowance observed in production resets at midnight UTC.
  it.each([
    ["account", 1],
    ["model", 3],
  ] as const)("makes %i provider call(s) for a %s-scoped 429", async (limitScope, calls) => {
    provider.script("mid", Array.from({ length: 4 }, () => ({
      kind: "error" as const,
      error: new ProviderError("p1", "rate_limit", "429", { status: 429, limitScope }),
    })));
    const p = broker.complete(req(runId, "mid")).catch((error: unknown) => error);
    await clock.advance(100);
    await clock.advance(200);
    expect(await p).toBeInstanceOf(ProviderError);
    expect(provider.calls).toHaveLength(calls);
  });

  // R1 AC5. Nine models probed under one exhausted account quota otherwise each carry a routing
  // penalty for a condition none of them caused.
  it.each([
    ["account", 0],
    ["model", 1],
    ["unknown", 1],
  ] as const)("records a %s-scoped 429 as %i routing failures", async (limitScope, failures) => {
    provider.script("mid", [{ kind: "error", error: new ProviderError("p1", "rate_limit", "429", { status: 429, limitScope }) }]);
    await expect(broker.complete({
      ...req(runId, "mid"),
      metadata: { runId, purpose: "test", role: "worker", retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } },
    })).rejects.toThrow(ProviderError);
    expect(catalog.get({ provider: "p1", model: "mid" })?.stats.failures).toBe(failures);
    expect(store.events.list(runId, { types: ["model.observation.recorded"] })).toHaveLength(failures);
    // Recorded as a call either way: what happened is not in question, only whose fault it was.
    expect(store.events.list(runId, { types: ["model.call"] })).toHaveLength(1);
  });

  it("charges a probe to the budget and records its event, but not its routing statistics", async () => {
    provider.script("big", [{ kind: "error", error: new ProviderError("p1", "rate_limit", "429", { status: 429 }) }]);
    provider.script("mid", [{ kind: "reply", content: "ok", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.002 } }]);
    const probe = (model: string): CompletionRequest => ({
      ...req(runId, model),
      metadata: { runId, purpose: "capability_probe_tools", role: "probe", retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } },
    });
    await expect(broker.complete(probe("big"))).rejects.toThrow(ProviderError);
    await broker.complete(probe("mid"));

    // The account being out of free requests today says nothing about "big".
    expect(catalog.get({ provider: "p1", model: "big" })?.stats).toMatchObject({ calls: 0, failures: 0 });
    expect(catalog.get({ provider: "p1", model: "mid" })?.stats.calls).toBe(0);
    expect(store.events.list(runId, { types: ["model.observation.recorded"] })).toHaveLength(0);
    // Spend and the call record are not optional for a probe: they are the point of R0.
    expect(store.events.list(runId, { types: ["model.call"] })).toHaveLength(2);
    expect(budget.snapshot(runId)).toMatchObject({ runUsd: 0.002 });

    await broker.complete({ ...req(runId, "mid"), metadata: { runId, purpose: "test", role: "worker" } });
    expect(catalog.get({ provider: "p1", model: "mid" })?.stats.calls).toBe(1);
  });

  it("retries retryable errors with backoff, cools down on rate limits, and gives up after maxAttempts", async () => {
    provider.script("mid", [
      { kind: "error", error: new ProviderError("p1", "rate_limit", "slow down", { retryAfterMs: 500 }) },
      { kind: "error", error: new ProviderError("p1", "server", "oops") },
      { kind: "reply", content: "ok" },
    ]);
    const p = broker.complete(req(runId, "mid"));
    await clock.advance(500);
    await clock.advance(200);
    const rec = await p;
    expect(rec.attempts).toBe(3);
    expect(rec.response.message.content).toBe("ok");
    const stats = catalog.get({ provider: "p1", model: "mid" })!.stats;
    expect(stats.calls).toBe(3);
    expect(stats.failures).toBe(2);

    provider.script("mid", [
      { kind: "error", error: new ProviderError("p1", "server", "1") },
      { kind: "error", error: new ProviderError("p1", "server", "2") },
      { kind: "error", error: new ProviderError("p1", "server", "3") },
    ]);
    const failing = broker.complete(req(runId, "mid"));
    const settled = failing.catch((e: unknown) => e);
    await clock.advance(100);
    await clock.advance(200);
    await clock.advance(400);
    const err = await settled;
    expect(err).toBeInstanceOf(ProviderError);
    const events = store.events.list(runId, { types: ["model.call"] });
    expect(events.at(-1)!.payload).toMatchObject({ ok: false, attempts: 3 });
    expect(store.events.list(runId, { types: ["model.retry_scheduled"] }).length).toBeGreaterThanOrEqual(2);
  });

  it("does not retry non-retryable errors and marks the provider unavailable on auth failure", async () => {
    provider.script("big", [{ kind: "error", error: new ProviderError("p1", "auth", "bad key") }]);
    await expect(broker.complete(req(runId, "big"))).rejects.toThrow(/bad key/);
    expect(provider.calls).toHaveLength(1);
    expect(catalog.get({ provider: "p1", model: "big" })?.available).toBe(false);
  });

  it("refuses calls once the run budget is exhausted", async () => {
    provider.script("big", [{ kind: "reply", content: "x", usage: { inputTokens: 900, outputTokens: 200 } }]);
    await broker.complete(req(runId, "big"));
    let caught: unknown;
    try {
      await broker.complete(req(runId, "big"));
    } catch (e) {
      caught = e;
    }
    expect(isBudgetError(caught)).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });

  it("restores budget and stats from events", async () => {
    provider.script("big", [{ kind: "reply", content: "x", usage: { inputTokens: 300, outputTokens: 100, costUsd: 0.2 } }]);
    await broker.complete({ ...req(runId, "big"), metadata: { runId, purpose: "t", role: "worker", taskId: "task_x" } });
    catalog.recordQuality({ provider: "p1", model: "big" }, 0.8);
    const historicalQuality = catalog.get({ provider: "p1", model: "big" })!.stats.quality;
    const fresh = new BudgetTracker({ maxRunUsd: null, maxRunTokens: null, maxTaskTokens: null });
    const fresh2 = new ModelBroker({ store, clock, catalog, quota: new QuotaTracker(clock, { concurrency: 1, rpm: null }), budget: fresh, secrets: SecretStore.fromValues({}) });
    fresh2.restore(runId);
    expect(fresh.snapshot(runId)).toEqual({ runUsd: 0.2, runTokens: 400, perTask: { task_x: 400 }, unknownCostCalls: [] });
    expect(catalog.get({ provider: "p1", model: "big" })!.stats.quality).toBe(historicalQuality);
  });

  it("persists attempt outcomes so restore rebuilds retry stats", async () => {
    provider.script("mid", [
      { kind: "error", error: new ProviderError("p1", "server", "1") },
      { kind: "error", error: new ProviderError("p1", "server", "2") },
      { kind: "reply", content: "ok", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } },
    ]);
    const p = broker.complete(req(runId, "mid"));
    await clock.advance(100);
    await clock.advance(200);
    await p;
    expect(catalog.get({ provider: "p1", model: "mid" })!.stats).toMatchObject({ calls: 3, failures: 2 });

    const restoredCatalog = new ModelCatalog();
    restoredCatalog.register(provider);
    await restoredCatalog.refresh();
    const restored = new ModelBroker({
      store,
      clock,
      catalog: restoredCatalog,
      quota: new QuotaTracker(clock, { concurrency: 1, rpm: null }),
      budget: new BudgetTracker({ maxRunUsd: null, maxRunTokens: null, maxTaskTokens: null }),
      secrets: SecretStore.fromValues({}),
    });
    restored.restore(runId);
    expect(restoredCatalog.get({ provider: "p1", model: "mid" })!.stats).toMatchObject({ calls: 3, failures: 2 });
  });

  it("records a failed model.call when the caller aborts and stores generation controls", async () => {
    provider.script("big", [
      {
        kind: "fn",
        fn: async () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        },
      },
    ]);
    await expect(broker.complete({
      ...req(runId, "big"),
      maxTokens: 123,
      temperature: 0.25,
      responseSchema: EMPIRICAL_SCORE_RESPONSE_SCHEMA,
      reasoning: DISABLED_REASONING,
    })).rejects.toThrow(/aborted/);
    const events = store.events.list(runId, { types: ["model.call"] });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ ok: false, attempts: 1 });
    const reqText = store.artifacts.getText(events[0]!.artifacts[0]!.sha256);
    expect(JSON.parse(reqText)).toMatchObject({
      maxTokens: 123,
      temperature: 0.25,
      responseSchema: EMPIRICAL_SCORE_RESPONSE_SCHEMA,
      reasoning: DISABLED_REASONING,
    });
  });

  it("records a model.call when cancelled while waiting for quota or during retry backoff", async () => {
    const sharedQuota = new QuotaTracker(clock, { concurrency: 1, rpm: null });
    const quotaBroker = new ModelBroker({
      store,
      clock,
      catalog,
      quota: sharedQuota,
      budget,
      secrets: SecretStore.fromValues({ OPENROUTER_API_KEY: "sk-supersecret-value" }),
      retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 },
      jitter: () => 1,
    });
    const callsBeforeQuota = catalog.get({ provider: "p1", model: "big" })?.stats.calls ?? 0;
    const releaseSlot = await sharedQuota.acquire("p1");
    const ac1 = new AbortController();
    const waiting = quotaBroker.complete({ ...req(runId, "big"), signal: ac1.signal });
    const waitingSettled = waiting.catch((e: unknown) => e);
    await clock.advance(10);
    ac1.abort();
    await clock.advance(60);
    await waitingSettled;
    const quotaEvents = store.events.list(runId, { types: ["model.call"] });
    expect(quotaEvents).toHaveLength(1);
    expect(quotaEvents[0]!.payload).toMatchObject({ ok: false });
    expect(provider.calls.filter((c) => c.metadata.runId === runId)).toHaveLength(0);
    expect(catalog.get({ provider: "p1", model: "big" })?.stats.calls ?? 0).toBe(callsBeforeQuota);
    expect((quotaEvents[0]!.payload["attemptOutcomes"] as unknown[]).length).toBe(0);
    releaseSlot();

    const run2 = id("run");
    const midBeforeCalls = catalog.get({ provider: "p1", model: "mid" })!.stats.calls;
    const midBeforeFailures = catalog.get({ provider: "p1", model: "mid" })!.stats.failures;
    provider.script("mid", [{ kind: "error", error: new ProviderError("p1", "server", "retry me") }]);
    const ac2 = new AbortController();
    const backoff = broker.complete({ ...req(run2, "mid"), signal: ac2.signal });
    const backoffSettled = backoff.catch((e: unknown) => e);
    await clock.advance(1);
    ac2.abort();
    await clock.advance(200);
    await backoffSettled;
    const backoffEvents = store.events.list(run2, { types: ["model.call"] });
    expect(backoffEvents).toHaveLength(1);
    expect(backoffEvents[0]!.payload).toMatchObject({ ok: false, attempts: 1 });
    expect(provider.calls.filter((c) => c.metadata.runId === run2)).toHaveLength(1);
    expect((backoffEvents[0]!.payload["attemptOutcomes"] as unknown[]).length).toBe(1);
    expect(catalog.get({ provider: "p1", model: "mid" })!.stats.calls).toBe(midBeforeCalls + 1);
    expect(catalog.get({ provider: "p1", model: "mid" })!.stats.failures).toBe(midBeforeFailures + 1);
  });
});

describe("QuotaTracker", () => {
  it("limits concurrency per provider and honours cool-downs", async () => {
    const clock = new FakeClock(NOW);
    const q = new QuotaTracker(clock, { concurrency: 1, rpm: null });
    const r1 = await q.acquire("p");
    let second = false;
    const p2 = q.acquire("p").then((r) => {
      second = true;
      return r;
    });
    await clock.advance(10);
    expect(second).toBe(false);
    r1();
    await clock.advance(60);
    expect(second).toBe(true);
    (await p2)();
    q.coolDown("p", 5000);
    expect(q.availableIn("p")).toBe(5000);
    await clock.advance(5000);
    expect(q.availableIn("p")).toBe(0);
  });

  it("enforces requests-per-minute windows", async () => {
    const clock = new FakeClock(NOW);
    const q = new QuotaTracker(clock, { concurrency: 10, rpm: 2 });
    (await q.acquire("p"))();
    (await q.acquire("p"))();
    expect(q.availableIn("p")).toBe(60_000);
    await clock.advance(60_001);
    expect(q.availableIn("p")).toBe(0);
  });
});

describe("ModelRouter", () => {
  function catalogWith(): ModelCatalog {
    const c = new ModelCatalog();
    c.register(new ScriptedProvider("p", []));
    c.upsert({ ref: { provider: "p", model: "a-frontier" }, displayName: "a", capabilities: { ...FAKE_CAPABILITIES.frontier, family: "alpha" }, source: "provider" });
    c.upsert({ ref: { provider: "p", model: "a2-frontier" }, displayName: "a2", capabilities: { ...FAKE_CAPABILITIES.frontier, family: "alpha" }, source: "provider" });
    c.upsert({ ref: { provider: "p", model: "b-strong" }, displayName: "b", capabilities: { ...FAKE_CAPABILITIES.strong, family: "beta" }, source: "provider" });
    c.upsert({ ref: { provider: "p", model: "c-fast" }, displayName: "c", capabilities: { ...FAKE_CAPABILITIES.fast, family: "gamma" }, source: "provider" });
    return c;
  }

  it("filters by capability requirements and excludes", () => {
    const router = new ModelRouter(catalogWith());
    const strong = router.select({ role: "worker", count: 10, minTier: "strong" }).map((r) => r.entry.info.ref.model);
    expect(strong).not.toContain("c-fast");
    const json = router.select({ role: "reviewer", count: 10, requireJson: true }).map((r) => r.entry.info.ref.model);
    expect(json).not.toContain("c-fast");
    const excl = router.select({ role: "reviewer", count: 10, exclude: [{ provider: "p", model: "a-frontier" }] }).map((r) => r.entry.info.ref.model);
    expect(excl).not.toContain("a-frontier");
  });

  it("spreads picks across families as a soft preference that never outweighs a tier gap", () => {
    const c = catalogWith();
    c.upsert({ ref: { provider: "p", model: "d-frontier" }, displayName: "d", capabilities: { ...FAKE_CAPABILITIES.frontier, family: "delta" }, source: "provider" });
    const router = new ModelRouter(c);
    const picks = router.select({ role: "reviewer", count: 3 }).map((r) => r.entry.info.ref.model);
    // among equal-quality frontier models, the second pick goes to the other family
    expect(picks.slice(0, 2).sort()).toEqual(["a-frontier", "d-frontier"]);
    // the third pick is the remaining frontier model: diversity (0.08) does not beat the tier gap to b-strong (0.15)
    expect(picks[2]).toBe("a2-frontier");
    // c-fast (prior 0.5) is below the rotation floor and never receives the diversity bonus
    const fast = router.rank({ role: "reviewer", count: 1 }).find((r) => r.entry.info.ref.model === "c-fast");
    expect(fast?.reasons).not.toContain("diverse-family");
  });

  it("uses observed quality over tier priors and penalises failures", () => {
    const c = catalogWith();
    for (let i = 0; i < 20; i++) c.recordQuality({ provider: "p", model: "b-strong" }, 1);
    for (let i = 0; i < 20; i++) c.recordQuality({ provider: "p", model: "a-frontier" }, 0);
    for (let i = 0; i < 4; i++) c.recordCall({ provider: "p", model: "a2-frontier" }, { ok: false, latencyMs: 1, errorKind: "server", at: NOW });
    const router = new ModelRouter(c);
    const ranked = router.rank({ role: "worker", count: 3 }).map((r) => r.entry.info.ref.model);
    expect(ranked[0]).toBe("b-strong");
    expect(ranked.indexOf("a-frontier")).toBeGreaterThan(ranked.indexOf("c-fast"));
    expect(ranked.at(-1)).toMatch(/a-frontier|a2-frontier/);
  });

  it("skips models whose provider is unavailable", () => {
    const c = catalogWith();
    c.setProviderAvailable("p", false);
    expect(new ModelRouter(c).select({ role: "worker", count: 3 })).toEqual([]);
  });
});

describe("SecretStore", () => {
  it("parses dotenv, warns on non-600 permissions, redacts and never exposes values in names()", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-secrets-"));
    try {
      const file = join(dir, "secrets.env");
      writeFileSync(file, `# comment\nexport OPENROUTER_API_KEY="sk-or-abcdefgh"\nGROQ_API_KEY=gsk_12345678 # trailing\nBAD LINE\n`);
      chmodSync(file, 0o644);
      const s = SecretStore.fromFile(file, { GEMINI_API_KEY: "AIzaSyXXXXXXXX", PATH: "/bin" });
      expect(s.names()).toEqual(["GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY"]);
      expect(s.get("OPENROUTER_API_KEY")).toBe("sk-or-abcdefgh");
      expect(s.get("GROQ_API_KEY")).toBe("gsk_12345678");
      expect(s.warnings[0]).toMatch(/chmod 600/);
      expect(s.redact("key gsk_12345678 and sk-or-abcdefgh")).toBe("key <redacted:GROQ_API_KEY> and <redacted:OPENROUTER_API_KEY>");
      expect(() => s.get("NOPE")).toThrow(/not configured/);
      expect(parseDotenv("A='x y'\nB=z")).toEqual([["A", "x y"], ["B", "z"]]);

      chmodSync(file, 0o400);
      const strict = SecretStore.fromFile(file, {});
      expect(strict.warnings[0]).toMatch(/mode is 400/);

      process.env["POLISH_TEST_REPRO_API_KEY"] = "repro-secret-key";
      try {
        const fromEnv = SecretStore.fromFile(join(dir, "missing.env"));
        expect(fromEnv.has("POLISH_TEST_REPRO_API_KEY")).toBe(true);
      } finally {
        delete process.env["POLISH_TEST_REPRO_API_KEY"];
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RecordReplayProvider", () => {
  it("records responses keyed by request content and replays them without the inner adapter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-rr-"));
    try {
      const inner = new ScriptedProvider("real", [{ name: "m", capabilities: FAKE_CAPABILITIES.fast }]);
      inner.script("m", [{ kind: "reply", content: "recorded answer" }]);
      const cassette = join(dir, "cassette.json");
      const rec = new RecordReplayProvider("real", cassette, "record", inner);
      expect(await rec.listModels()).toHaveLength(1);
      const r = await rec.complete(req("run_x", "m", "real", "question"));
      expect(r.message.content).toBe("recorded answer");

      const replay = new RecordReplayProvider("real", cassette, "replay", null);
      expect((await replay.listModels())[0]?.ref.model).toBe("m");
      const again = await replay.complete({ ...req("run_y", "m", "real", "question"), metadata: { runId: "run_y", purpose: "different", role: "reviewer" } });
      expect(again.message.content).toBe("recorded answer");
      await expect(replay.complete(req("run_y", "m", "real", "other question"))).rejects.toThrow(/no recorded response/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GroqProvider redaction", () => {
  function fakeFetch(handler: (url: string, init: Parameters<FetchLike>[1]) => { status: number; body: unknown; headers?: Record<string, string> }): FetchLike {
    return (url, init) => {
      const r = handler(url, init);
      return Promise.resolve({
        status: r.status,
        headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
        text: () => Promise.resolve(typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
      });
    };
  }

  it("never persists raw Groq API keys in model.call artifacts", async () => {
    const secret = "gsk_live_secret_key_value_12345678";
    const provider = new GroqProvider({
      id: "groq",
      apiKey: secret,
      fetch: fakeFetch((url) => {
        if (url.endsWith("/models")) {
          return { status: 200, body: { data: [{ id: "llama-3.3-70b-versatile", context_length: 131072, supported_parameters: ["tools"] }] } };
        }
        return {
          status: 200,
          body: {
            choices: [{ message: { content: `echo ${secret}` }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 5 },
          },
        };
      }),
    });
    const redactCatalog = new ModelCatalog();
    redactCatalog.register(provider);
    await redactCatalog.refresh();
    const redactDir = mkdtempSync(join(tmpdir(), "polish-broker-groq-"));
    const redactStore = openStore({ artifactsDir: join(redactDir, "artifacts") });
    const redactRunId = id("run");
    try {
      const redactBroker = new ModelBroker({
        store: redactStore,
        clock: new FakeClock(NOW),
        catalog: redactCatalog,
        quota: new QuotaTracker(new FakeClock(NOW), { concurrency: 1, rpm: null }),
        budget: new BudgetTracker({ maxRunUsd: null, maxRunTokens: null, maxTaskTokens: null }),
        secrets: SecretStore.fromValues({ GROQ_API_KEY: secret }),
      });
      await redactBroker.complete({
        model: { provider: "groq", model: "llama-3.3-70b-versatile" },
        messages: [{ role: "user", content: `use ${secret}` }],
        metadata: { runId: redactRunId, purpose: "test", role: "worker" },
      });
      const events = redactStore.events.list(redactRunId, { types: ["model.call"] });
      expect(events).toHaveLength(1);
      for (const artifact of events[0]!.artifacts) {
        const text = redactStore.artifacts.getText(artifact.sha256);
        expect(text).not.toContain(secret);
        expect(text).toContain("<redacted:GROQ_API_KEY>");
      }
    } finally {
      redactStore.close();
      rmSync(redactDir, { recursive: true, force: true });
    }
  });
});

describe("OpenAICompatProvider", () => {
  function fakeFetch(handler: (url: string, init: Parameters<FetchLike>[1]) => { status: number; body: unknown; headers?: Record<string, string> }): FetchLike {
    return (url, init) => {
      const r = handler(url, init);
      return Promise.resolve({
        status: r.status,
        headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
        text: () => Promise.resolve(typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
      });
    };
  }

  it("maps requests, responses, tool calls and model listings", async () => {
    const seen: { url: string; body: unknown; auth: string }[] = [];
    const p = new OpenAICompatProvider({
      id: "or",
      kind: "openrouter",
      baseUrl: "https://example.test/api/v1/",
      apiKey: "sk-test",
      fetch: fakeFetch((url, init) => {
        seen.push({ url, body: init.body ? JSON.parse(init.body) : null, auth: init.headers["authorization"] ?? "" });
        if (url.endsWith("/models")) {
          return {
            status: 200,
            body: {
              data: [
                { id: "anthropic/claude-x", name: "Claude X", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools", "response_format"] },
                { id: "meta-llama/llama-y", context_length: 131072, pricing: { prompt: "0.0000001", completion: "0.0000001" }, supported_parameters: ["temperature"] },
              ],
            },
          };
        }
        return {
          status: 200,
          body: {
            id: "gen-1",
            choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a"}' } }] }, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 12, completion_tokens: 7, cost: 0.0001 },
          },
        };
      }),
    });
    const models = await p.listModels();
    expect(models[0]).toMatchObject({ ref: { provider: "or", model: "anthropic/claude-x" }, capabilities: { family: "anthropic", tier: "frontier", supportsTools: true, supportsJson: true, inputCostPerM: 3, outputCostPerM: 15 } });
    expect(models[1]?.capabilities).toMatchObject({ family: "meta-llama", tier: "fast", supportsTools: false, supportsJson: false });
    expect(seen[0]?.url).toBe("https://example.test/api/v1/models");
    expect(seen[0]?.auth).toBe("Bearer sk-test");

    const r = await p.complete({
      model: { provider: "or", model: "anthropic/claude-x" },
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "t", arguments: "{}" }] },
        { role: "tool", content: "result", toolCallId: "c0" },
      ],
      tools: [{ name: "read_file", description: "d", parameters: { type: "object" } }],
      responseFormat: "json",
      maxTokens: 100,
      metadata: { runId: "run_z", purpose: "p", role: "worker" },
    });
    expect(r.finishReason).toBe("tool_calls");
    expect(r.message).toMatchObject({ role: "assistant", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }] });
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 7, costUsd: 0.0001 });
    expect(r.providerResponseId).toBe("gen-1");
    const body = seen[1]?.body as Record<string, unknown>;
    expect(body["model"]).toBe("anthropic/claude-x");
    expect(body["response_format"]).toEqual({ type: "json_object" });
    expect(body["max_tokens"]).toBe(100);
    expect((body["messages"] as unknown[])[3]).toEqual({ role: "tool", content: "result", tool_call_id: "c0" });
    expect((body["tools"] as unknown[])[0]).toMatchObject({ type: "function", function: { name: "read_file" } });
  });

  it("classifies HTTP errors with retry-after", async () => {
    const statuses = [429, 401, 500, 400, 404];
    let i = 0;
    const p = new OpenAICompatProvider({
      id: "groq",
      kind: "groq",
      baseUrl: "https://example.test",
      apiKey: "k",
      fetch: fakeFetch(() => ({ status: statuses[i++]!, body: { error: { message: "nope" } }, headers: { "retry-after": "7" } })),
    });
    const kinds: string[] = [];
    const retryAfter: (number | null)[] = [];
    for (const _status of statuses) {
      try {
        await p.complete(req("run_e", "m", "groq"));
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderError);
        kinds.push((e as ProviderError).kind);
        retryAfter.push((e as ProviderError).retryAfterMs);
      }
    }
    expect(kinds).toEqual(["rate_limit", "auth", "server", "bad_request", "not_found"]);
    expect(retryAfter[0]).toBe(7000);
  });

  it("rejects a pre-aborted signal without calling fetch", async () => {
    let fetches = 0;
    const p = new OpenAICompatProvider({
      id: "or",
      kind: "openrouter",
      baseUrl: "https://example.test",
      apiKey: "k",
      fetch: fakeFetch(() => {
        fetches += 1;
        return { status: 200, body: { choices: [{ message: { content: "x" }, finish_reason: "stop" }] } };
      }),
    });
    const ac = new AbortController();
    ac.abort();
    await expect(p.complete({ ...req("run_a", "m", "or"), signal: ac.signal })).rejects.toThrow(/aborted/);
    expect(fetches).toBe(0);
  });

  it("infers families and tiers without hard-coded model names", () => {
    expect(inferFamily("openai/gpt-x")).toBe("openai");
    expect(inferFamily("gemini-3-flash")).toBe("google");
    expect(inferFamily("llama-4-maverick")).toBe("meta");
    expect(inferFamily("qwen-coder")).toBe("qwen");
    expect(inferTier("x", 5, 100)).toBe("frontier");
    expect(inferTier("x", 0.5, 100)).toBe("strong");
    expect(inferTier("x", null, 200_000)).toBe("strong");
    expect(inferTier("x", null, 8_000)).toBe("fast");
  });
});

describe("ScriptedProvider", () => {
  it("echoes the last user message by default", async () => {
    const p = new ScriptedProvider("s", [{ name: "m", capabilities: FAKE_CAPABILITIES.fast }]);
    const r = await p.complete(req("run_s", "m", "s", "echo me"));
    expect(r.message.content).toBe("echo me");
    expect(reply("x").finishReason).toBe("stop");
  });
});
