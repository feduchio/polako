import { describe, expect, it } from "vitest";
import { lmsResidencyControl, parseLmsPs } from "./lmstudioControl.js";

describe("lmsResidencyControl", () => {
  it("issues ps/load/unload with the documented flags", async () => {
    const calls: string[][] = [];
    const control = lmsResidencyControl({
      contextLength: 65_536,
      run: (args) => {
        calls.push([...args]);
        return Promise.resolve(args[0] === "ps" ? JSON.stringify([{ type: "llm", modelKey: "ornith", identifier: "night" }]) : "");
      },
    });
    expect(await control.loaded()).toEqual([{ modelKey: "ornith", identifier: "night" }]);
    await control.load("ornith", "ornith");
    await control.unload("night");
    expect(calls).toEqual([
      ["ps", "--json"],
      ["load", "ornith", "-c", "65536", "--parallel", "1", "--gpu", "max", "--identifier", "ornith", "-y"],
      ["unload", "night"],
    ]);
  });
});

describe("parseLmsPs", () => {
  it("reads instances, defaults the identifier to the key, ignores non-LLMs and garbage", () => {
    const out = JSON.stringify([
      { type: "llm", modelKey: "a" },
      { type: "embedding", modelKey: "e", identifier: "e" },
      { nokey: true },
    ]);
    expect(parseLmsPs(out)).toEqual([{ modelKey: "a", identifier: "a" }]);
    expect(parseLmsPs("No models are currently loaded.")).toEqual([]);
    expect(parseLmsPs("[oops")).toEqual([]);
  });
});
