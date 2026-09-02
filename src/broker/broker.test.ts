import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_CAPABILITIES, ScriptedProvider, reply } from "../providers/scripted.js";
import { RecordReplayProvider } from "../providers/recordReplay.js";
import { OpenAICompatProvider, inferFamily, inferTier, type FetchLike } from "../providers/openaiCompat.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { ModelBroker } from "./broker.js";
import { ModelCatalog } from "./catalog.js";
import { BudgetTracker, QuotaTracker, isBudgetError } from "./quota.js";
import { ModelRouter } from "./router.js";
import { SecretStore, parseDotenv } from "./secrets.js";
import { ProviderError, type CompletionRequest } from "./types.js";

const NOW = 1_700_000_000_000;

function req(runId: string, model: string, provider = "p1", content = "hello"): CompletionRequest {
  return { model: { provider, model }, messages: [{ role: "user", content }], metadata: { runId, purpose: "test", role: "worker" } };
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
    const fresh = new BudgetTracker({ maxRunUsd: null, maxRunTokens: null, maxTaskTokens: null });
    const fresh2 = new ModelBroker({ store, clock, catalog, quota: new QuotaTracker(clock, { concurrency: 1, rpm: null }), budget: fresh, secrets: SecretStore.fromValues({}) });
    fresh2.restore(runId);
    expect(fresh.snapshot(runId)).toEqual({ runUsd: 0.2, runTokens: 400, perTask: { task_x: 400 } });
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
  it("parses dotenv, warns on loose permissions, redacts and never exposes values in names()", () => {
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
