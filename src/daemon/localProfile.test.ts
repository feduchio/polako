import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPolishConfig } from "./configLoad.js";
import { applyLocalProfile, isLocalProfile } from "../domain/localProfile.js";
import { defaultConfig } from "../domain/config.js";

describe("local profile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function load(toml: string) {
    const home = mkdtempSync(join(tmpdir(), "polako-profile-"));
    dirs.push(home);
    writeFileSync(join(home, "polako.toml"), toml);
    return loadPolishConfig(home);
  }

  it("is selected when every enabled provider is lmstudio", () => {
    expect(isLocalProfile({ providers: [{ kind: "lmstudio" }] })).toBe(true);
    expect(isLocalProfile({ providers: [{ kind: "lmstudio" }, { kind: "openrouter", enabled: false }] })).toBe(true);
    expect(isLocalProfile({ providers: [{ kind: "lmstudio" }, { kind: "openrouter" }] })).toBe(false);
    expect(isLocalProfile({ providers: [] })).toBe(false);
    expect(isLocalProfile({})).toBe(false);
  });

  it("can be forced either way", () => {
    expect(isLocalProfile({ profile: "local", providers: [{ kind: "openrouter" }] })).toBe(true);
    expect(isLocalProfile({ profile: "cloud", providers: [{ kind: "lmstudio" }] })).toBe(false);
  });

  it("gives an all-local config the local defaults", () => {
    const config = load('[[providers]]\nid = "local"\nkind = "lmstudio"\n');
    expect(config.execution.maxParallelTasks).toBe(1);
    expect(config.candidates).toEqual({ trivial: 1, normal: 1, complex: 2 });
    expect(config.review.reviewersPerRound).toBe(2);
    expect(config.review.sameModelFallback).toBe(true);
    expect(config.review.maxOutputTokens).toBe(4096);
    expect(config.review.falsifiabilityAudit).toBe(true);
    expect(config.agent.progressEnabled).toBe(false);
    expect(config.agent.maxTurns).toBe(80);
    expect(config.lanes["llm.default"]).toBe(1);
    expect(config.providers[0]).toMatchObject({ manageResidency: true, timeoutMs: 1_800_000, contextLength: 65_536 });
  });

  it("lets anything the user wrote win", () => {
    const config = load('[execution]\nmaxParallelTasks = 3\n[review]\nreviewersPerRound = 3\nsameModelFallback = false\n[[providers]]\nid = "local"\nkind = "lmstudio"\nmanageResidency = false\ntimeoutMs = 60000\n');
    expect(config.execution.maxParallelTasks).toBe(3);
    expect(config.review.reviewersPerRound).toBe(3);
    expect(config.review.sameModelFallback).toBe(false);
    expect(config.review.maxOutputTokens).toBe(4096);
    expect(config.providers[0]).toMatchObject({ manageResidency: false, timeoutMs: 60_000, contextLength: 65_536 });
  });

  it("leaves a cloud or mixed config exactly upstream's", () => {
    const mixed = load('[[providers]]\nid = "local"\nkind = "lmstudio"\n[[providers]]\nid = "openrouter"\nkind = "openrouter"\napiKeyEnv = "K"\n');
    const base = defaultConfig();
    expect(mixed.execution).toEqual(base.execution);
    expect(mixed.review).toEqual(base.review);
    expect(mixed.candidates).toEqual(base.candidates);
    expect(mixed.providers[0]).not.toHaveProperty("manageResidency");
  });

  it("does not mutate its input", () => {
    const raw = { providers: [{ kind: "lmstudio", id: "x" }] };
    const merged = applyLocalProfile(raw);
    expect(raw.providers[0]).toEqual({ kind: "lmstudio", id: "x" });
    expect(merged).not.toBe(raw);
  });
});
