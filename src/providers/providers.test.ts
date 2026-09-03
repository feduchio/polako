import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "./openaiCompat.js";
import { GeminiProvider } from "./gemini.js";
import { GroqProvider } from "./groq.js";
import { OpenRouterProvider } from "./openrouter.js";

const FIXTURES = join(import.meta.dirname, "../../fixtures/providers");

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

export function fakeFetch(handler: (url: string, init: Parameters<FetchLike>[1]) => { status: number; body: unknown; headers?: Record<string, string> }): FetchLike {
  return (url, init) => {
    const r = handler(url, init);
    return Promise.resolve({
      status: r.status,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      text: () => Promise.resolve(typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    });
  };
}

describe("OpenRouterProvider", () => {
  it("lists models and sends OpenRouter attribution headers", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const provider = new OpenRouterProvider({
      id: "openrouter",
      apiKey: "sk-or-test-key-12345678",
      baseUrl: "https://openrouter.test/api/v1",
      fetch: fakeFetch((url, init) => {
        seen.push({ url, headers: init.headers });
        if (url.endsWith("/models")) return { status: 200, body: fixture("openrouter-models.json") };
        return { status: 200, body: { choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
      }),
    });
    expect(provider.kind).toBe("openrouter");
    const models = await provider.listModels();
    expect(models[0]?.ref).toEqual({ provider: "openrouter", model: "anthropic/claude-sonnet-4" });
    expect(seen[0]?.headers["HTTP-Referer"]).toBeDefined();
    expect(seen[0]?.headers["X-Title"]).toBe("Polish");
    expect(seen[0]?.headers["authorization"]).toBe("Bearer sk-or-test-key-12345678");
  });
});

describe("GroqProvider", () => {
  it("uses the Groq OpenAI-compat base URL and kind", async () => {
    let modelsUrl = "";
    const provider = new GroqProvider({
      id: "groq",
      apiKey: "gsk_test_key_12345678",
      fetch: fakeFetch((url, _init) => {
        if (url.endsWith("/models")) {
          modelsUrl = url;
          return { status: 200, body: fixture("groq-models.json") };
        }
        return { status: 200, body: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
      }),
    });
    expect(provider.kind).toBe("groq");
    const models = await provider.listModels();
    expect(models[0]?.ref.model).toBe("llama-3.3-70b-versatile");
    expect(modelsUrl).toBe("https://api.groq.com/openai/v1/models");
  });
});

describe("GeminiProvider", () => {
  it("uses the Gemini OpenAI-compat endpoint with kind gemini", async () => {
    let modelsUrl = "";
    const provider = new GeminiProvider({
      id: "gemini",
      apiKey: "AIzaSyTestKey12345678",
      fetch: fakeFetch((url) => {
        if (url.endsWith("/models")) {
          modelsUrl = url;
          return { status: 200, body: fixture("gemini-models.json") };
        }
        return { status: 200, body: { choices: [{ message: { content: "{\"probe\":\"ok\"}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
      }),
    });
    expect(provider.kind).toBe("gemini");
    const models = await provider.listModels();
    expect(models[0]?.ref.model).toBe("gemini-2.0-flash");
    expect(modelsUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
  });
});

describe("createProviderFromConfig", () => {
  it("instantiates named adapters without embedding secrets in adapter ids", async () => {
    const { createProviderFromConfig } = await import("./factory.js");
    const or = createProviderFromConfig({ id: "or", kind: "openrouter", enabled: true, apiKeyEnv: "OPENROUTER_API_KEY" }, "sk-secret");
    expect(or?.kind).toBe("openrouter");
    expect(or?.id).toBe("or");
  });
});
