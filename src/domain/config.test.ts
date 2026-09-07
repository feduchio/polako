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
    expect(cfg.council.maxAttemptsPerModel).toBe(2);
    expect(cfg.verifier.backend).toBe("sidecar");
    expect(cfg.convergence.noProgressAttempts).toBe(3);
    expect(cfg.convergence.taskGrowthWindow).toBe(3);
    expect(cfg.convergence.findingOscillationWindow).toBe(4);
    expect(cfg.convergence.checkpointOscillationWindow).toBe(4);
    expect(cfg.convergence.maxDebateRounds).toBe(2);
    expect(cfg.audition.enabled).toBe(false);
    expect(cfg.audition.strategy).toBe("noop");
    expect(cfg.audition.minScoresForRouting).toBe(3);
    expect(cfg.audition.maxModels).toBe(4);
    expect(cfg.audition.maxTasks).toBe(4);
    expect(cfg.audition.tasks.length).toBeGreaterThan(0);
  });

  it("accepts an additive [audition] section and keeps existing keys parseable", () => {
    const cfg = PolishConfigSchema.parse({
      audition: {
        enabled: true,
        strategy: "micro-tasks",
        minScoresForRouting: 4,
        maxModels: 2,
        maxTasks: 2,
        tasks: [{ id: "echo", prompt: "say hi", expected: "hi" }],
      },
    });
    expect(cfg.audition.enabled).toBe(true);
    expect(cfg.audition.strategy).toBe("micro-tasks");
    expect(cfg.audition.minScoresForRouting).toBe(4);
    expect(cfg.audition.tasks).toEqual([{ id: "echo", prompt: "say hi", expected: "hi" }]);
    expect(PolishConfigSchema.parse({ routing: { costEligibility: "free_only" } }).audition.enabled).toBe(false);
  });

  it("rejects a non-positive maxDebateRounds and keeps existing toml parseable", () => {
    expect(() => PolishConfigSchema.parse({ convergence: { maxDebateRounds: 0 } })).toThrow();
    expect(PolishConfigSchema.parse({ convergence: { requiredCleanRounds: 2 } }).convergence.maxDebateRounds).toBe(2);
  });

  it("rejects fail-open or permanently-silent C2 window knobs", () => {
    expect(() => PolishConfigSchema.parse({ convergence: { findingOscillationWindow: 5 } })).toThrow();
    expect(() => PolishConfigSchema.parse({ convergence: { checkpointOscillationWindow: 5 } })).toThrow();
    expect(() => PolishConfigSchema.parse({ convergence: { noProgressAttempts: 1 } })).toThrow();
    expect(() => PolishConfigSchema.parse({ convergence: { taskGrowthWindow: 1 } })).toThrow();
    expect(PolishConfigSchema.parse({ convergence: { findingOscillationWindow: 6 } }).convergence.findingOscillationWindow).toBe(6);
    expect(PolishConfigSchema.parse({ convergence: { noProgressAttempts: 2 } }).convergence.noProgressAttempts).toBe(2);
  });

  it("accepts an ordered supervisor fallback chain", () => {
    const cfg = PolishConfigSchema.parse({
      supervisors: [
        {
          role: "judge",
          models: ["openrouter:z-ai/glm-5.2:free", "gemini:gemini-3.8-flash"],
        },
      ],
    });
    expect(cfg.supervisors[0]?.model).toBe("openrouter:z-ai/glm-5.2:free");
    expect(cfg.supervisors[0]?.models).toEqual([
      "openrouter:z-ai/glm-5.2:free",
      "gemini:gemini-3.8-flash",
    ]);
  });

  it("rejects a supervisor pin with neither model nor models", () => {
    expect(() => PolishConfigSchema.parse({ supervisors: [{ role: "judge" }] })).toThrow();
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
