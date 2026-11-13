import { describe, expect, it } from "vitest";
import { ProviderError } from "../broker/types.js";
import { distinctFamilies } from "../broker/diversity.js";
import { createProviderFromConfig } from "./factory.js";
import {
  adaptLmStudioPayload,
  LMSTUDIO_DEFAULT_TIMEOUT_MS,
  LmStudioProvider,
  lmStudioFamily,
  parseLmsCatalog,
  type LmsModelMeta,
} from "./lmstudio.js";
import { fakeFetch } from "./providers.test.js";

const CATALOG: LmsModelMeta[] = [
  { type: "llm", modelKey: "ornith-1.5-35b-a3b", displayName: "Ornith 1.5 35B", publisher: "ornith-ai", architecture: "qwen35moe", paramsString: "35B", trainedForToolUse: true, maxContextLength: 262_144, path: "ornith-ai/Ornith-1.5-35B-A3B-GGUF/Ornith-1.5-35B-Q4_K_M.gguf" },
  { type: "llm", modelKey: "swift-1.5-qwen3.8-27b", displayName: "Swift 1.5 Qwen3.8 27B", architecture: "qwen35", paramsString: "27B", trainedForToolUse: true, maxContextLength: 262_144 },
  { type: "llm", modelKey: "huihui-qwen3.8-27b-abliterated", architecture: "qwen35", paramsString: "27B", trainedForToolUse: false, maxContextLength: 32_768 },
  { type: "llm", modelKey: "tiny-3b", architecture: "llama", paramsString: "3B", trainedForToolUse: true, maxContextLength: 8_192 },
  { type: "embedding", modelKey: "text-embedding-nomic-embed-text-v1.5", architecture: "nomic-bert", maxContextLength: 2_048 },
];

const META = { runId: "r", purpose: "p", role: "worker" };

const SERVED = {
  data: [
    { id: "ornith-1.5-35b-a3b", object: "model" },
    { id: "swift-1.5-qwen3.8-27b", object: "model" },
    { id: "huihui-qwen3.8-27b-abliterated", object: "model" },
    { id: "tiny-3b", object: "model" },
    { id: "text-embedding-nomic-embed-text-v1.5", object: "model" },
    { id: "unlisted-model", object: "model" },
  ],
};

function provider(overrides: Partial<ConstructorParameters<typeof LmStudioProvider>[0]> = {}): LmStudioProvider {
  return new LmStudioProvider({
    id: "local",
    fetch: fakeFetch(() => ({ status: 200, body: SERVED })),
    catalog: () => Promise.resolve(CATALOG),
    ...overrides,
  });
}

describe("LmStudioProvider", () => {
  it("talks to localhost:1234 without an API key, one request at a time", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const p = provider({
      fetch: fakeFetch((url, init) => {
        seen.push({ url, headers: init.headers });
        return { status: 200, body: SERVED };
      }),
    });
    expect(p.kind).toBe("lmstudio");
    expect(p.concurrency).toBe(1);
    await p.listModels();
    expect(seen[0]?.url).toBe("http://localhost:1234/v1/models");
    expect(seen[0]?.headers["authorization"]).toBe("Bearer lm-studio");
  });

  it("maps LM Studio metadata to broker capabilities", async () => {
    const byModel = Object.fromEntries((await provider().listModels()).map((m) => [m.ref.model, m]));
    const ornith = byModel["ornith-1.5-35b-a3b"];
    expect(ornith?.ref).toEqual({ provider: "local", model: "ornith-1.5-35b-a3b" });
    expect(ornith?.displayName).toBe("Ornith 1.5 35B");
    expect(ornith?.capabilities).toMatchObject({
      contextWindow: 65_536, // capped at the context the model is loaded with, not 262144
      supportsTools: true,
      supportsJson: true,
      inputCostPerM: 0,
      outputCostPerM: 0,
      tier: "strong",
      family: "local-qwen35moe-ornith-1.5-35b-a3b",
    });
    expect(byModel["huihui-qwen3.8-27b-abliterated"]?.capabilities).toMatchObject({ supportsTools: false, contextWindow: 32_768 });
    expect(byModel["tiny-3b"]?.capabilities.tier).toBe("fast");
  });

  it("leaves embedding models out of the listing", async () => {
    const ids = (await provider().listModels()).map((m) => m.ref.model);
    expect(ids).not.toContain("text-embedding-nomic-embed-text-v1.5");
    expect(ids).toContain("unlisted-model");
  });

  it("degrades to /v1/models alone when the lms CLI is unavailable", async () => {
    const p = provider({ catalog: () => Promise.reject(new Error("lms not found")) });
    const models = await p.listModels();
    const unlisted = models.find((m) => m.ref.model === "unlisted-model");
    expect(unlisted?.capabilities).toMatchObject({ supportsTools: false, contextWindow: 65_536, inputCostPerM: 0, tier: "fast", family: "local-unknown-unlisted-model" });
    expect(models.map((m) => m.ref.model)).not.toContain("text-embedding-nomic-embed-text-v1.5");
  });

  it("honours contextLength and capabilityHints (hints win)", async () => {
    const p = provider({ contextLength: 131_072, capabilityHints: { "swift-1.5-qwen3.8-27b": { contextWindow: 50_000, family: "swift" } } });
    const byModel = Object.fromEntries((await p.listModels()).map((m) => [m.ref.model, m]));
    expect(byModel["ornith-1.5-35b-a3b"]?.capabilities.contextWindow).toBe(131_072);
    expect(byModel["swift-1.5-qwen3.8-27b"]?.capabilities).toMatchObject({ contextWindow: 50_000, family: "swift" });
  });

  it("treats distinct fine-tunes as distinct families so the diversity rule can pick several", async () => {
    const models = (await provider().listModels()).filter((m) => m.capabilities.family.startsWith("local-qwen"));
    expect(models.length).toBe(3);
    expect(distinctFamilies(models, (m) => m.capabilities.family)).toHaveLength(3);
    // ...whereas the vendor rule alone would have seen one family.
    expect(lmStudioFamily("qwen3.8-27b-splash-abliterated", { architecture: "qwen3_5" })).toBe("local-qwen3-5-qwen3.8-27b-splash-abliterated");
    expect(lmStudioFamily("x", { architecture: "qwen35" })).not.toBe(lmStudioFamily("y", { architecture: "qwen35" }));
  });

  it("keeps one family for one model key even if two quants share it", async () => {
    const p = provider({ catalog: () => Promise.resolve([{ type: "llm", modelKey: "dup", architecture: "qwen35", maxContextLength: 1000 }, { type: "llm", modelKey: "dup", architecture: "qwen35", maxContextLength: 2000 }]), fetch: fakeFetch(() => ({ status: 200, body: { data: [{ id: "dup" }] } })) });
    const models = await p.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.capabilities.contextWindow).toBe(1000);
  });

  it("completes a chat, with zero cost, tool calls and a rewritten json_object format", async () => {
    let captured: Record<string, unknown> = {};
    const p = provider({
      fetch: fakeFetch((url, init) => {
        captured = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        expect(url).toBe("http://localhost:1234/v1/chat/completions");
        return {
          status: 200,
          body: {
            id: "chatcmpl-1",
            choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 11, completion_tokens: 3 },
          },
        };
      }),
    });
    const res = await p.complete({
      model: { provider: "local", model: "ornith-1.5-35b-a3b" },
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "ls", description: "list", parameters: { type: "object" } }],
      responseFormat: "json",
      metadata: META,
    });
    expect(res.finishReason).toBe("tool_calls");
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 3, costUsd: null });
    expect(res.message).toMatchObject({ toolCalls: [{ id: "c1", name: "ls" }] });
    expect(captured["model"]).toBe("ornith-1.5-35b-a3b");
    expect(captured["response_format"]).toEqual({ type: "json_schema", json_schema: { name: "json_object", schema: { type: "object" } } });
  });

  it("leaves strict json_schema and other payloads alone", () => {
    const strict = { response_format: { type: "json_schema", json_schema: { name: "s", strict: true, schema: {} } } };
    expect(adaptLmStudioPayload(strict)).toBe(strict);
    const plain = { model: "m" };
    expect(adaptLmStudioPayload(plain)).toBe(plain);
  });

  it("waits up to 30 minutes by default and times out per config", async () => {
    expect(LMSTUDIO_DEFAULT_TIMEOUT_MS).toBe(30 * 60_000);
    const hang: ReturnType<typeof fakeFetch> = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    const p = provider({ fetch: hang, timeoutMs: 20 });
    await expect(p.complete({ model: { provider: "local", model: "m" }, messages: [{ role: "user", content: "x" }], metadata: META })).rejects.toMatchObject({ kind: "timeout" });
    await expect(p.complete({ model: { provider: "local", model: "m" }, messages: [], metadata: META })).rejects.toBeInstanceOf(ProviderError);
  });

  it("reports health false when the server is down", async () => {
    const p = provider({ fetch: () => Promise.reject(new Error("ECONNREFUSED")) });
    expect(await p.health()).toMatchObject({ ok: false, detail: expect.stringContaining("ECONNREFUSED") as unknown });
  });
});

describe("parseLmsCatalog", () => {
  it("parses rows, tolerates banners and garbage", () => {
    const json = JSON.stringify([{ type: "llm", modelKey: "a", trainedForToolUse: true }, { nokey: 1 }]);
    expect(parseLmsCatalog(`Loading...\n${json}\n`).map((m) => m.modelKey)).toEqual(["a"]);
    expect(parseLmsCatalog("")).toEqual([]);
    expect(parseLmsCatalog("[not json]")).toEqual([]);
  });
});

describe("createProviderFromConfig lmstudio", () => {
  it("builds an LmStudioProvider with concurrency 1 and no key", () => {
    const adapter = createProviderFromConfig({ id: "local", kind: "lmstudio", enabled: true }, "");
    expect(adapter).toBeInstanceOf(LmStudioProvider);
    expect(adapter?.concurrency).toBe(1);
  });

  it("passes baseUrl, concurrency and timeout from config", async () => {
    const urls: string[] = [];
    const adapter = createProviderFromConfig(
      { id: "local", kind: "lmstudio", enabled: true, baseUrl: "http://192.168.1.5:1234/v1", concurrency: 2, timeoutMs: 5_000, lmsPath: "/nonexistent/lms" },
      "",
      { fetch: fakeFetch((url) => { urls.push(url); return { status: 200, body: { data: [] } }; }) },
    );
    expect(adapter?.concurrency).toBe(2);
    await adapter?.listModels();
    expect(urls).toEqual(["http://192.168.1.5:1234/v1/models"]);
  });
});
