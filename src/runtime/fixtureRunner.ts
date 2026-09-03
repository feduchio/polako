import { access } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { RuntimeCapabilityClass, RuntimeEvidence } from "../domain/acceptance.js";
import { runProcess } from "../sandbox/process.js";
import { id } from "../shared/ids.js";
import type {
  HttpSmokeScenario,
  NodeScriptScenario,
  RuntimeAvailability,
  RuntimeScenario,
  RuntimeValidator,
} from "./types.js";

export type RuntimeFetch = (input: string, init: { method: "GET"; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface FixtureRuntimeValidatorOptions {
  fetch?: RuntimeFetch;
  now?: () => number;
  /** Explicit side effects require both scenario declaration and runner opt-in. */
  allowExplicitSideEffects?: boolean;
}

/**
 * Local fixture validator. Safe node scripts run under Node's permission model
 * (read-only, no network). Safe HTTP smoke is loopback GET only.
 */
export class FixtureRuntimeValidator implements RuntimeValidator {
  readonly id = "fixture-runtime";
  private readonly fetchImpl: RuntimeFetch;
  private readonly now: () => number;

  constructor(private readonly options: FixtureRuntimeValidatorOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  supports(_scenario: RuntimeScenario): boolean {
    return true;
  }

  async availability(scenario: RuntimeScenario): Promise<RuntimeAvailability> {
    const policyProblem = this.policyProblem(scenario);
    if (policyProblem !== null) {
      return { available: false, capability: "AVAILABLE_UNSAFE", reason: policyProblem };
    }
    if (scenario.kind === "node_script") {
      try {
        await access(resolveScript(scenario), constants.R_OK);
        return { available: true, capability: "AVAILABLE_SAFE" };
      } catch (error) {
        return {
          available: false,
          capability: "UNAVAILABLE",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    try {
      const url = new URL(scenario.url);
      if (!isLoopback(url.hostname)) {
        return { available: false, capability: "AVAILABLE_UNSAFE", reason: `network host ${url.hostname} is not loopback` };
      }
      return { available: true, capability: "AVAILABLE_SAFE" };
    } catch {
      return { available: false, capability: "UNAVAILABLE", reason: "invalid HTTP smoke URL" };
    }
  }

  async validate(scenario: RuntimeScenario, signal?: AbortSignal): Promise<RuntimeEvidence> {
    const startedAt = this.now();
    const availability = await this.availability(scenario);
    if (!availability.available) {
      return this.evidence(scenario, startedAt, "unavailable", availability.reason ?? "runtime unavailable", {}, availability.capability);
    }
    if (scenario.kind === "node_script") return this.validateNode(scenario, startedAt, signal);
    return this.validateHttp(scenario, startedAt, signal);
  }

  private async validateNode(scenario: NodeScriptScenario, startedAt: number, signal?: AbortSignal): Promise<RuntimeEvidence> {
    const root = realpathSync(resolve(scenario.fixtureRoot));
    const script = realpathSync(resolveScript(scenario));
    const safe = scenario.sideEffectPolicy !== "explicit";
    const permissions = [permissionFlag(), `--allow-fs-read=${root}`];
    if (!safe) {
      permissions.push(`--allow-fs-write=${root}`);
      const networkHosts = scenario.allowedNetworkHosts ?? [];
      if (networkHosts.length > 0) permissions.push(`--allow-net=${networkHosts.join(",")}`);
    }
    const result = await runProcess({
      argv: [process.execPath, ...permissions, script, ...(scenario.args ?? [])],
      cwd: root,
      timeoutMs: scenario.timeoutMs ?? 30_000,
      maxOutputBytes: 65_536,
      ...(signal === undefined ? {} : { signal }),
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        TMPDIR: process.env["TMPDIR"] ?? "/tmp",
        NODE_NO_WARNINGS: "1",
        POLISH_RUNTIME_VALIDATION: "1",
        POLISH_SIDE_EFFECT_POLICY: safe ? "safe" : "explicit",
      },
    });
    const status = result.exitCode === 0 ? "passed" : "failed";
    return this.evidence(
      scenario,
      startedAt,
      status,
      status === "passed" ? "fixture node scenario passed" : `fixture node scenario failed with exit ${result.exitCode}`,
      { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut },
    );
  }

  private async validateHttp(scenario: HttpSmokeScenario, startedAt: number, signal?: AbortSignal): Promise<RuntimeEvidence> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, scenario.timeoutMs ?? 10_000);
    const onAbort = (): void => {
      controller.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetchImpl(scenario.url, { method: "GET", signal: controller.signal });
      const body = (await response.text()).slice(0, 65_536);
      const expectedStatus = scenario.expectedStatus ?? 200;
      const statusMatches = response.status === expectedStatus;
      const bodyMatches = scenario.expectedBodyIncludes === undefined || body.includes(scenario.expectedBodyIncludes);
      const passed = statusMatches && bodyMatches;
      return this.evidence(
        scenario,
        startedAt,
        passed ? "passed" : "failed",
        passed ? "HTTP smoke scenario passed" : "HTTP smoke response did not match expectations",
        { status: response.status, expectedStatus, bodyMatches, body },
      );
    } catch (error) {
      return this.evidence(
        scenario,
        startedAt,
        "failed",
        error instanceof Error ? error.message : String(error),
        {},
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private evidence(
    scenario: RuntimeScenario,
    startedAt: number,
    status: RuntimeEvidence["status"],
    summary: string,
    observations: Record<string, unknown>,
    capability: RuntimeCapabilityClass = "AVAILABLE_SAFE",
  ): RuntimeEvidence {
    const explicit = scenario.sideEffectPolicy === "explicit";
    return {
      id: id("rte", startedAt),
      runId: scenario.runId,
      scenarioId: scenario.id,
      validator: this.id,
      kind: scenario.kind,
      status,
      summary,
      observations: { ...observations, capability },
      checkpointHash: scenario.checkpointHash,
      sideEffects: {
        policy: explicit ? "explicit" : "safe",
        destructiveExternalEffectsAllowed: explicit,
      },
      artifactHashes: [],
      startedAt,
      finishedAt: this.now(),
    };
  }

  private policyProblem(scenario: RuntimeScenario): string | null {
    return scenario.sideEffectPolicy === "explicit" && this.options.allowExplicitSideEffects !== true
      ? "explicit side effects are disabled"
      : null;
  }
}

function resolveScript(scenario: NodeScriptScenario): string {
  const root = resolve(scenario.fixtureRoot);
  const script = resolve(root, scenario.script);
  if (script !== root && !script.startsWith(`${root}${sep}`)) {
    throw new Error("runtime script must remain inside fixtureRoot");
  }
  return script;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function permissionFlag(): string {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return major >= 23 ? "--permission" : "--experimental-permission";
}
