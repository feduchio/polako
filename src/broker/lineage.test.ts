import { describe, expect, it } from "vitest";
import { localLineage } from "./lineage.js";

describe("localLineage", () => {
  it.each([
    [{ modelKey: "ornith-1.5-35b-a3b", architecture: "qwen35moe" }, "qwen"],
    [{ modelKey: "swift-1.5-qwen3.8-27b", architecture: "qwen35" }, "qwen"],
    [{ modelKey: "qwen3.8-27b-splash-abliterated", architecture: "qwen3_5" }, "qwen"],
    [{ modelKey: "huihui-qwen3.8-27b-coder390-efficientthink-abliterated-val-apex-i-miniplus-v3", architecture: "qwen35" }, "qwen"],
    [{ modelKey: "openai/gpt-oss-20b", architecture: "gpt-oss" }, "openai"],
    [{ modelKey: "google/gemma-4-12b-qat", architecture: "gemma4" }, "google"],
    [{ modelKey: "ibm/granite-4.2-8b", architecture: "granitehybrid" }, "ibm"],
    [{ modelKey: "llama-3.3-70b", architecture: "llama" }, "meta"],
    [{ modelKey: "mistral-small-3", architecture: "mistral3" }, "mistralai"],
    [{ modelKey: "devstral-small", architecture: "mistral" }, "mistralai"],
  ])("%j -> %s", (source, lineage) => {
    expect(localLineage(source)).toBe(lineage);
  });

  it("uses the name when the architecture is silent, and a fine-tune's brand counts as its base", () => {
    expect(localLineage({ modelKey: "ornith-1.5-35b-a3b" })).toBe("qwen");
    expect(localLineage({ modelKey: "some-gpt-oss-120b" })).toBe("openai");
    expect(localLineage({ modelKey: "x", displayName: "Granite 4 H", path: "ibm/granite" })).toBe("ibm");
  });

  it("falls back to the architecture for an unknown lineage, and to unknown for nothing", () => {
    expect(localLineage({ modelKey: "mystery-7b", architecture: "falcon_h1" })).toBe("falcon-h1");
    expect(localLineage({ modelKey: "mystery-7b" })).toBe("unknown");
  });

  it("does not take a fine-tuner's name for a lineage", () => {
    expect(localLineage({ modelKey: "unsloth-gemma-3", architecture: "gemma3", publisher: "unsloth" })).toBe("google");
  });
});
