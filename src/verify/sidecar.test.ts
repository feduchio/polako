import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CandidateMetrics } from "./metrics.js";
import { defaultConfig } from "../domain/config.js";
import { decomposeCriteria, defaultPython, sidecarScriptPath, createVerifierStrategy, VerifierAdapter } from "./sidecar.js";
import { PairwiseJudge } from "./pairwise.js";
import type { TournamentCandidate } from "./strategy.js";

const SIDECAR_DIR = dirname(sidecarScriptPath());
const SCRIPT = sidecarScriptPath();

function candidate(id: string, linesChanged: number, extra?: Partial<CandidateMetrics>): TournamentCandidate {
  const metrics: CandidateMetrics = {
    candidateId: id,
    filesChanged: 1,
    linesChanged,
    insertions: linesChanged,
    deletions: 0,
    checksPassed: 2,
    checksTotal: 2,
    newFailures: 0,
    newFailureKeys: [],
    ...extra,
  };
  return { id, metrics };
}

function ensureSidecarVenv(): string {
  const python = defaultPython(SCRIPT);
  const probe = spawnSync(python, ["-c", "import llm_verifier, clients"], {
    encoding: "utf8",
    cwd: SIDECAR_DIR,
  });
  if (probe.status === 0) return python;
  const venvDir = join(SIDECAR_DIR, ".venv");
  execFileSync("python3", ["-m", "venv", venvDir], { stdio: "pipe" });
  const venvPython = join(venvDir, "bin", "python");
  execFileSync(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], { stdio: "pipe" });
  execFileSync(venvPython, ["-m", "pip", "install", "-r", join(SIDECAR_DIR, "requirements.txt")], {
    stdio: "pipe",
  });
  return venvPython;
}

let python = "python3";

beforeAll(() => {
  python = ensureSidecarVenv();
}, 120_000);

const adapters: VerifierAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.close();
});

function adapter(env: NodeJS.ProcessEnv, timeoutMs = 8_000): VerifierAdapter {
  const created = new VerifierAdapter({
    command: python,
    scriptPath: SCRIPT,
    requestTimeoutMs: timeoutMs,
    repeats: 1,
    pivots: 2,
    env: { POLISH_VERIFIER_CLIENT: "scripted", ...env },
  });
  adapters.push(created);
  return created;
}

describe("VerifierAdapter", () => {
  it("falls back to TypeScript pairwise scoring when the sidecar is down", async () => {
    const down = new VerifierAdapter({
      command: "__polish_missing_python__",
      requestTimeoutMs: 100,
    });
    adapters.push(down);
    await expect(
      down.comparePair(candidate("a", 2), candidate("b", 20), { runId: "run_fallback" }),
    ).resolves.toMatchObject({ winner: "a" });
    expect(down.usedFallback).toBe(true);
  });

  it("decomposes task and acceptance criteria and supplies safe defaults", () => {
    expect(decomposeCriteria("Pass tests.\nAvoid regressions; keep scope small")).toEqual([
      "Pass tests",
      "Avoid regressions",
      "keep scope small",
    ]);
    expect(decomposeCriteria(undefined, ["Keep the diff small"])).toEqual(["Keep the diff small"]);
    expect(decomposeCriteria(undefined, [], ["specification", "output"])).toEqual(["specification", "output"]);
    expect(decomposeCriteria(undefined)).toEqual(["correctness", "regression safety", "simplicity"]);
  });

  it("createVerifierStrategy constructs VerifierAdapter only for sidecar backend", () => {
    const knobs = {
      repeats: 2,
      granularity: 20,
      criteria: ["specification"],
      pivotTournamentFrom: 4,
    };
    expect(createVerifierStrategy({ backend: "ts", ...knobs })).toBeInstanceOf(PairwiseJudge);
    const sidecar = createVerifierStrategy({ backend: "sidecar", ...knobs }, { command: "__unused__" });
    expect(sidecar).toBeInstanceOf(VerifierAdapter);
    (sidecar as VerifierAdapter).close();
  });
});

describe("VerifierAdapter real Python child", () => {
  it("reports health against llm-verifier", async () => {
    const sidecar = adapter({});
    await expect(sidecar.health()).resolves.toBe(true);
  });

  it("passes decomposed criteria through compare", async () => {
    const sidecar = adapter({ POLISH_VERIFIER_PREFER: "a" });
    const verdict = await sidecar.comparePair(candidate("a", 99), candidate("b", 1), {
      runId: "run_criteria",
      task: "Honor the named criterion.",
      acceptance: ["Prefer the injected winner id"],
    });
    expect(verdict.winner).toBe("a");
    expect(verdict.rationale.length).toBeGreaterThan(0);
    expect(sidecar.lastProvenance.criteria.join(" ")).toMatch(/Honor the named criterion|Prefer the injected winner/);
    expect(sidecar.usedFallback).toBe(false);
  });

  it("runs PPT select for N large enough for pivots and ignores heuristic metrics", async () => {
    const sidecar = adapter({ POLISH_VERIFIER_PREFER: "p4" });
    const frontier = [
      candidate("p0", 1, { checksPassed: 9, newFailures: 0 }),
      candidate("p1", 1, { checksPassed: 9, newFailures: 0 }),
      candidate("p2", 1, { checksPassed: 9, newFailures: 0 }),
      candidate("p3", 1, { checksPassed: 9, newFailures: 0 }),
      candidate("p4", 80, { checksPassed: 1, newFailures: 3 }),
    ];
    const result = await sidecar.selectFrontier(frontier, {
      runId: "run_ppt",
      task: "Pick the preferred id.",
      acceptance: ["Winner is the injected id"],
    }, { repeats: 1, pivots: 2 });
    expect(result.method).toBe("ppt");
    expect(result.fallback).toBe(false);
    expect(result.winnerId).toBe("p4");
    expect(result.client).toBe("scripted");
    expect(sidecar.lastProvenance.client).toBe("scripted");
    expect(result.nComparisons).toBeGreaterThanOrEqual(frontier.length);
    expect(result.nComparisons).toBeLessThan(frontier.length * (frontier.length - 1));
    expect(result.criteria.length).toBeGreaterThan(0);
  }, 30_000);

  it("default createVerifierStrategy sidecar uses scripted PPT without POLISH_VERIFIER_CLIENT in options.env", async () => {
    const previousClient = process.env["POLISH_VERIFIER_CLIENT"];
    delete process.env["POLISH_VERIFIER_CLIENT"];
    try {
      const strategy = createVerifierStrategy(
        { backend: "sidecar", repeats: 1, granularity: 20, criteria: [], pivotTournamentFrom: 4 },
        {
          command: python,
          scriptPath: SCRIPT,
          requestTimeoutMs: 8_000,
          repeats: 1,
          pivots: 2,
          env: { POLISH_VERIFIER_PREFER: "d1" },
        },
      );
      expect(strategy).toBeInstanceOf(VerifierAdapter);
      const sidecar = strategy as VerifierAdapter;
      adapters.push(sidecar);
      const frontier = [candidate("d0", 1), candidate("d1", 80, { checksPassed: 1, newFailures: 3 })];
      const result = await sidecar.selectFrontier(
        frontier,
        { runId: "run_default_scripted", task: "Pick the preferred id.", acceptance: ["Winner is the injected id"] },
        { repeats: 1, pivots: 2 },
      );
      expect(result.method).toBe("ppt");
      expect(result.fallback).toBe(false);
      expect(result.winnerId).toBe("d1");
      expect(result.client).toBe("scripted");
      expect(sidecar.lastProvenance.client).toBe("scripted");
      expect(sidecar.usedFallback).toBe(false);
    } finally {
      if (previousClient === undefined) delete process.env["POLISH_VERIFIER_CLIENT"];
      else process.env["POLISH_VERIFIER_CLIENT"] = previousClient;
    }
  }, 30_000);

  it("default production sidecar uses TS judge when scripted PPT scores do not discriminate", async () => {
    const previousPrefer = process.env["POLISH_VERIFIER_PREFER"];
    const previousClient = process.env["POLISH_VERIFIER_CLIENT"];
    delete process.env["POLISH_VERIFIER_PREFER"];
    delete process.env["POLISH_VERIFIER_CLIENT"];
    try {
      const strategy = createVerifierStrategy(defaultConfig().verifier, {
        command: python,
        scriptPath: SCRIPT,
        requestTimeoutMs: 8_000,
        repeats: 1,
        pivots: 2,
      });
      expect(strategy).toBeInstanceOf(VerifierAdapter);
      const sidecar = strategy as VerifierAdapter;
      adapters.push(sidecar);
      const weak = candidate("cand-weak", 80, { checksPassed: 1, newFailures: 3 });
      const mid = candidate("cand-mid", 20, { checksPassed: 4, newFailures: 1 });
      const strong = candidate("cand-strong", 2, { checksPassed: 9, newFailures: 0 });
      const context = { runId: "run_nondiscriminating", task: "Pick the stronger candidate." };
      const forward = await sidecar.selectFrontier([weak, mid, strong], context, { repeats: 1, pivots: 2 });
      const reversed = await sidecar.selectFrontier([strong, mid, weak], context, { repeats: 1, pivots: 2 });
      expect(forward.winnerId).toBe("cand-strong");
      expect(reversed.winnerId).toBe(forward.winnerId);
      expect(forward.fallback).toBe(true);
      expect(reversed.fallback).toBe(true);
      expect(forward.method).toBe("pairwise");
      expect(reversed.method).toBe("pairwise");
      expect(sidecar.usedFallback).toBe(true);
      expect(sidecar.lastProvenance.fallback).toBe(true);
      expect(sidecar.lastProvenance.client).toBe("scripted");
      expect(forward.client).toBe("scripted");
    } finally {
      if (previousPrefer === undefined) delete process.env["POLISH_VERIFIER_PREFER"];
      else process.env["POLISH_VERIFIER_PREFER"] = previousPrefer;
      if (previousClient === undefined) delete process.env["POLISH_VERIFIER_CLIENT"];
      else process.env["POLISH_VERIFIER_CLIENT"] = previousClient;
    }
  }, 30_000);

  it("does not let ambient process.env POLISH_VERIFIER_ALLOW_LIVE enable live create_client", async () => {
    const previousLive = process.env["POLISH_VERIFIER_ALLOW_LIVE"];
    const previousClient = process.env["POLISH_VERIFIER_CLIENT"];
    process.env["POLISH_VERIFIER_ALLOW_LIVE"] = "1";
    delete process.env["POLISH_VERIFIER_CLIENT"];
    try {
      const strategy = createVerifierStrategy(defaultConfig().verifier, {
        command: python,
        scriptPath: SCRIPT,
        requestTimeoutMs: 8_000,
        repeats: 1,
        pivots: 2,
      });
      expect(strategy).toBeInstanceOf(VerifierAdapter);
      const sidecar = strategy as VerifierAdapter;
      adapters.push(sidecar);
      const weak = candidate("cand-weak", 80, { checksPassed: 1, newFailures: 3 });
      const strong = candidate("cand-strong", 2, { checksPassed: 9, newFailures: 0 });
      const result = await sidecar.selectFrontier(
        [strong, weak],
        { runId: "run_ambient_allow_live", task: "Ignore inherited billing switch." },
        { repeats: 1, pivots: 2 },
      );
      expect(result.winnerId).toBe("cand-strong");
      expect(result.fallback).toBe(true);
      expect(result.method).toBe("pairwise");
      expect(sidecar.lastProvenance.client).toBe("scripted");
      expect(sidecar.usedFallback).toBe(true);
    } finally {
      if (previousLive === undefined) delete process.env["POLISH_VERIFIER_ALLOW_LIVE"];
      else process.env["POLISH_VERIFIER_ALLOW_LIVE"] = previousLive;
      if (previousClient === undefined) delete process.env["POLISH_VERIFIER_CLIENT"];
      else process.env["POLISH_VERIFIER_CLIENT"] = previousClient;
    }
  }, 30_000);

  it("does not restore process.cwd() .env secrets into the sidecar child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-c3-dotenv-"));
    const previousCwd = process.cwd();
    writeFileSync(
      join(dir, ".env"),
      [
        "OPENAI_API_KEY=probe-from-dotenv",
        "OPENAI_BASE_URL=https://probe.example",
        "DEEPSEEK_API_KEY=probe-deepseek",
      ].join("\n"),
    );
    process.chdir(dir);
    try {
      const sidecar = adapter({
        POLISH_VERIFIER_PREFER: "a",
        POLISH_VERIFIER_ENV_PROBE: "OPENAI_API_KEY,OPENAI_BASE_URL,DEEPSEEK_API_KEY",
      });
      const result = await sidecar.selectFrontier(
        [candidate("a", 2), candidate("b", 20)],
        { runId: "run_dotenv", task: "Ignore cwd dotenv secrets." },
        { repeats: 1, pivots: 2 },
      );
      expect(result.winnerId).toBe("a");
      expect(result.method).toBe("ppt");
      expect(result.fallback).toBe(false);
      expect(sidecar.lastEnvProbe).toEqual({
        OPENAI_API_KEY: false,
        OPENAI_BASE_URL: false,
        DEEPSEEK_API_KEY: false,
      });
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not let ambient process.env POLISH_VERIFIER_PREFER pick the production winner", async () => {
    const previousPrefer = process.env["POLISH_VERIFIER_PREFER"];
    const previousClient = process.env["POLISH_VERIFIER_CLIENT"];
    process.env["POLISH_VERIFIER_PREFER"] = "cand-weak";
    delete process.env["POLISH_VERIFIER_CLIENT"];
    try {
      const strategy = createVerifierStrategy(defaultConfig().verifier, {
        command: python,
        scriptPath: SCRIPT,
        requestTimeoutMs: 8_000,
        repeats: 1,
        pivots: 2,
      });
      expect(strategy).toBeInstanceOf(VerifierAdapter);
      const sidecar = strategy as VerifierAdapter;
      adapters.push(sidecar);
      const weak = candidate("cand-weak", 80, { checksPassed: 1, newFailures: 3 });
      const strong = candidate("cand-strong", 2, { checksPassed: 9, newFailures: 0 });
      const result = await sidecar.selectFrontier(
        [strong, weak],
        { runId: "run_ambient_prefer", task: "Ignore inherited test hooks." },
        { repeats: 1, pivots: 2 },
      );
      expect(result.winnerId).toBe("cand-strong");
      expect(result.fallback).toBe(true);
      expect(result.method).toBe("pairwise");
      expect(sidecar.lastProvenance.client).toBe("scripted");
    } finally {
      if (previousPrefer === undefined) delete process.env["POLISH_VERIFIER_PREFER"];
      else process.env["POLISH_VERIFIER_PREFER"] = previousPrefer;
      if (previousClient === undefined) delete process.env["POLISH_VERIFIER_CLIENT"];
      else process.env["POLISH_VERIFIER_CLIENT"] = previousClient;
    }
  }, 30_000);

  it("records direct logprobs when the verifier exposes them", async () => {
    const sidecar = adapter({ POLISH_VERIFIER_SCRIPTED_MODE: "direct", POLISH_VERIFIER_PREFER: "a" });
    await sidecar.comparePair(candidate("a", 4), candidate("b", 4), { runId: "run_direct" });
    expect(sidecar.lastProvenance.logprobScheme).toBe("direct");
    expect(sidecar.usedFallback).toBe(false);
  }, 20_000);

  it("uses two-stage logprobs when the verifier withholds them", async () => {
    const sidecar = adapter({ POLISH_VERIFIER_SCRIPTED_MODE: "withheld", POLISH_VERIFIER_PREFER: "b" });
    const verdict = await sidecar.comparePair(candidate("a", 4), candidate("b", 4), { runId: "run_two_stage" });
    expect(verdict.winner).toBe("b");
    expect(sidecar.lastProvenance.logprobScheme).toBe("two_stage");
    expect(sidecar.usedFallback).toBe(false);
  }, 20_000);

  it("times out, restarts once, then falls back to TypeScript", async () => {
    const sidecar = adapter({ POLISH_VERIFIER_SLEEP_MS: "4000" }, 150);
    const verdict = await sidecar.comparePair(candidate("a", 2), candidate("b", 20), { runId: "run_timeout" });
    expect(verdict.winner).toBe("a");
    expect(sidecar.usedFallback).toBe(true);
  });

  it("restarts after a crash and then serves PPT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-c3-crash-"));
    const crashFile = join(dir, "crash-once");
    writeFileSync(crashFile, "1");
    try {
      const sidecar = adapter({ POLISH_VERIFIER_CRASH_FILE: crashFile, POLISH_VERIFIER_PREFER: "a" });
      const verdict = await sidecar.comparePair(candidate("a", 50), candidate("b", 1), { runId: "run_restart" });
      expect(verdict.winner).toBe("a");
      expect(sidecar.usedFallback).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("falls back when the sidecar reports on_error/failure", async () => {
    const sidecar = adapter({ POLISH_VERIFIER_FORCE_ERROR: "1" });
    const verdict = await sidecar.comparePair(candidate("a", 2), candidate("b", 20), { runId: "run_on_error" });
    expect(verdict.winner).toBe("a");
    expect(sidecar.usedFallback).toBe(true);
  });

  it("runs Python client unit tests including both logprob branches", () => {
    const result = spawnSync(python, [fileURLToPath(new URL("../../sidecars/llm_verifier/test_clients.py", import.meta.url))], {
      encoding: "utf8",
      cwd: SIDECAR_DIR,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
