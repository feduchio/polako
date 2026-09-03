import { describe, expect, it } from "vitest";
import { PolishConfigSchema, defaultConfig } from "./config.js";

describe("PolishConfig", () => {
  it("produces complete defaults from an empty object", () => {
    const cfg = defaultConfig();
    expect(cfg.lanes.integration).toBe(1);
    expect(cfg.convergence.requiredCleanRounds).toBe(3);
    expect(cfg.sandbox.backend).toBe("worktree");
    expect(cfg.sandbox.allowArbitraryCommands).toBe(false);
    expect(cfg.runtimeValidation.mode).toBe("auto");
    expect(cfg.lanes["local.runtime"]).toBe(1);
    expect(cfg.routing.costEligibility).toBe("free_only");
    expect(cfg.routing.maxInputCostPerM).toBe(0);
    expect(cfg.routing.maxOutputCostPerM).toBe(0);
  });

  it("rejects an integration lane wider than 1", () => {
    expect(() => PolishConfigSchema.parse({ lanes: { integration: 2 } })).toThrow();
  });

  it("rejects a local.runtime lane wider than 1", () => {
    expect(() => PolishConfigSchema.parse({ lanes: { "local.runtime": 2 } })).toThrow();
  });

  it("keeps provider keys out of config (only env var names)", () => {
    const cfg = PolishConfigSchema.parse({
      providers: [{ id: "or", kind: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" }],
    });
    expect(JSON.stringify(cfg)).not.toMatch(/sk-/);
    expect(cfg.providers[0]?.apiKeyEnv).toBe("OPENROUTER_API_KEY");
  });
});
