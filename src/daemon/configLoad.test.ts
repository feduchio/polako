import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretStore } from "../broker/secrets.js";
import { PolishError } from "../shared/errors.js";
import { loadConfiguredProviders, resolveCouncilRoles, buildProductionDeps } from "./composition.js";
import { loadPolishConfig, parseModelRefString } from "./configLoad.js";
import { FakeClock } from "../shared/clock.js";
import { openStore } from "../store/index.js";
import type { PhaseContext } from "../engine/types.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { id } from "../shared/ids.js";

describe("loadPolishConfig", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when polish.toml is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "polish-config-missing-"));
    dirs.push(home);
    const config = loadPolishConfig(home);
    expect(config.providers).toEqual([]);
    expect(config.supervisors).toEqual([]);
  });

  it("parses providers and supervisor pins from polish.toml", () => {
    const home = mkdtempSync(join(tmpdir(), "polish-config-valid-"));
    dirs.push(home);
    writeFileSync(
      join(home, "polish.toml"),
      `
[[providers]]
id = "scripted"
kind = "scripted"
enabled = true
models = ["planner", "wkr"]

[[providers]]
id = "openrouter"
kind = "openrouter"
enabled = true
apiKeyEnv = "OPENROUTER_API_KEY"

[[supervisors]]
role = "planner"
model = "scripted:planner"

[[supervisors]]
role = "scope_guardian"
model = "scripted:planner"

[[supervisors]]
role = "judge"
model = "scripted:planner"

[runtimeValidation]
mode = "off"
`,
    );
    const config = loadPolishConfig(home);
    expect(config.providers).toHaveLength(2);
    expect(config.supervisors).toHaveLength(3);
    expect(config.runtimeValidation.mode).toBe("off");
    expect(config.supervisors[0]?.model).toBe("scripted:planner");
  });

  it("parses routing cost eligibility from polish.toml", () => {
    const home = mkdtempSync(join(tmpdir(), "polish-config-routing-"));
    dirs.push(home);
    writeFileSync(
      join(home, "polish.toml"),
      `
[routing]
costEligibility = "ceiling"
maxInputCostPerM = 0.25
maxOutputCostPerM = 1
`,
    );
    const config = loadPolishConfig(home);
    expect(config.routing.costEligibility).toBe("ceiling");
    expect(config.routing.maxInputCostPerM).toBe(0.25);
    expect(config.routing.maxOutputCostPerM).toBe(1);
  });

  it("fails closed on invalid TOML schema", () => {
    const home = mkdtempSync(join(tmpdir(), "polish-config-invalid-"));
    dirs.push(home);
    writeFileSync(join(home, "polish.toml"), "[[providers]]\nid = \"x\"\nkind = \"not-a-provider\"\n");
    expect(() => loadPolishConfig(home)).toThrow(PolishError);
    try {
      loadPolishConfig(home);
    } catch (error) {
      expect((error as PolishError).code).toBe("CONFIG_ERROR");
    }
  });
});

describe("parseModelRefString", () => {
  it("splits provider and model on the first colon", () => {
    expect(parseModelRefString("gemini:models/gemini-3.8-flash")).toEqual({
      provider: "gemini",
      model: "models/gemini-3.8-flash",
    });
    expect(parseModelRefString("scripted:sup")).toEqual({ provider: "scripted", model: "sup" });
  });
});

describe("loadConfiguredProviders", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("loads scripted without apiKeyEnv and skips live providers without secrets", () => {
    const home = mkdtempSync(join(tmpdir(), "polish-providers-"));
    dirs.push(home);
    writeFileSync(join(home, "secrets.env"), "FAKE_SCRIPTED_KEY=not-used\n");
    writeFileSync(
      join(home, "polish.toml"),
      `
[[providers]]
id = "scripted"
kind = "scripted"
enabled = true
models = ["sup"]

[[providers]]
id = "openrouter"
kind = "openrouter"
enabled = true
apiKeyEnv = "OPENROUTER_API_KEY"
`,
    );
    const loaded = loadPolishConfig(home);
    const secrets = SecretStore.fromFile(join(home, "secrets.env"), {});
    const providers = loadConfiguredProviders(loaded, secrets, home);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("scripted");
  });
});

describe("resolveCouncilRoles", () => {
  let dir: string;
  let store: ReturnType<typeof openStore>;
  let clock: FakeClock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-council-resolve-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("honors pinned supervisors and records provenance events", () => {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "polish.toml"),
      `
[[providers]]
id = "scripted"
kind = "scripted"
enabled = true
models = ["planner", "scope", "judge"]

[[supervisors]]
role = "planner"
model = "scripted:planner"

[[supervisors]]
role = "scope_guardian"
model = "scripted:scope"

[[supervisors]]
role = "judge"
model = "scripted:judge"
`,
    );
    const config = loadPolishConfig(home);
    const provider = new ScriptedProvider("scripted", [
      { name: "planner", capabilities: { contextWindow: 128_000, maxOutputTokens: 8_000, supportsTools: true, supportsJson: true, inputCostPerM: 0.5, outputCostPerM: 1.5, tier: "strong", family: "beta" } },
      { name: "scope", capabilities: { contextWindow: 128_000, maxOutputTokens: 8_000, supportsTools: true, supportsJson: true, inputCostPerM: 0.5, outputCostPerM: 1.5, tier: "strong", family: "beta" } },
      { name: "judge", capabilities: { contextWindow: 128_000, maxOutputTokens: 8_000, supportsTools: true, supportsJson: true, inputCostPerM: 0.5, outputCostPerM: 1.5, tier: "strong", family: "beta" } },
    ]);
    const deps = buildProductionDeps({
      store,
      clock,
      config,
      home,
      providers: [provider],
    });
    const runId = id("run", clock.now());
    const ctx = {
      run: {
        id: runId,
        missionId: id("msn", clock.now()),
        projectPath: "/repo",
        runBranch: "polish/run",
        phase: "INTERPRETING_MISSION" as const,
        control: "RUNNING" as const,
        currentCheckpointHash: "a".repeat(40),
        baselineId: null,
        interpretationId: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        terminalReason: null,
      },
      store,
      scheduler: {} as PhaseContext["scheduler"],
      clock,
      config,
    } satisfies PhaseContext;

    const roles = resolveCouncilRoles(deps, ctx);
    expect(roles.planner.model).toEqual({ provider: "scripted", model: "planner" });
    expect(roles.scope_guardian.model).toEqual({ provider: "scripted", model: "scope" });
    expect(roles.judge.model).toEqual({ provider: "scripted", model: "judge" });

    const provenance = store.events.list(runId, { types: ["council.role_resolved"] });
    expect(provenance).toHaveLength(3);
    expect(provenance.every((event) => event.payload["configSource"] === "pinned")).toBe(true);
  });

  it("keeps explicitly pinned council models even when advertised pricing is paid or unknown", async () => {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "polish.toml"),
      `
[[providers]]
id = "scripted"
kind = "scripted"
enabled = true
models = ["planner", "scope", "judge"]

[[supervisors]]
role = "planner"
model = "scripted:planner"

[[supervisors]]
role = "scope_guardian"
model = "scripted:scope"

[[supervisors]]
role = "judge"
model = "scripted:judge"
`,
    );
    const config = loadPolishConfig(home);
    const provider = new ScriptedProvider("scripted", [
      { name: "planner", capabilities: { ...FAKE_CAPABILITIES.frontier, supportsJson: true, inputCostPerM: 3, outputCostPerM: 15 } },
      { name: "scope", capabilities: { ...FAKE_CAPABILITIES.strong, supportsJson: true, inputCostPerM: null, outputCostPerM: null } },
      { name: "judge", capabilities: { ...FAKE_CAPABILITIES.strong, supportsJson: true, inputCostPerM: 0.5, outputCostPerM: 1.5 } },
    ]);
    const deps = buildProductionDeps({ store, clock, config, home, providers: [provider] });
    await deps.catalog.discover();
    const roles = resolveCouncilRoles(deps);
    expect(roles.planner.model).toEqual({ provider: "scripted", model: "planner" });
    expect(roles.scope_guardian.model).toEqual({ provider: "scripted", model: "scope" });
    expect(roles.judge.model).toEqual({ provider: "scripted", model: "judge" });
    expect(deps.router.select({ role: "supervisor", count: 10, requireJson: true })).toEqual([]);
    expect(deps.router.select({ role: "judge", count: 10, requireJson: true })).toEqual([]);
  });
});
