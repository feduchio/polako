import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../sandbox/process.js";
import type {
  CodeGraphCommandCapability,
  CodeGraphContractProbeOptions,
  CodeGraphDialect,
  CodeGraphProbeResult,
} from "./types.js";

const DEFAULT_ENV: Record<string, string> = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
  HOME: process.env["HOME"] ?? "",
  LANG: process.env["LANG"] ?? "C",
};

const LOGICAL_COMMANDS: readonly {
  logical: string;
  aliases: readonly string[];
  optionAliases: Readonly<Record<string, readonly string[]>>;
  required: readonly string[];
}[] = [
  { logical: "init", aliases: ["init"], optionAliases: { json: ["--json", "-j"] }, required: [] },
  {
    logical: "search",
    aliases: ["search", "query"],
    optionAliases: { json: ["--json", "-j"], limit: ["--limit", "-l"] },
    required: ["json", "limit"],
  },
  { logical: "symbol", aliases: ["symbol", "node"], optionAliases: { json: ["--json", "-j"] }, required: [] },
  { logical: "callers", aliases: ["callers"], optionAliases: { json: ["--json", "-j"] }, required: ["json"] },
  { logical: "callees", aliases: ["callees"], optionAliases: { json: ["--json", "-j"] }, required: ["json"] },
  {
    logical: "impact",
    aliases: ["impact"],
    optionAliases: { json: ["--json", "-j"], depth: ["--depth", "-d"], symbol: ["--symbol"], file: ["--file"] },
    required: ["json"],
  },
  {
    logical: "affected-tests",
    aliases: ["affected-tests", "affected"],
    optionAliases: { json: ["--json", "-j"], file: ["--file"] },
    required: ["json"],
  },
  { logical: "refresh", aliases: ["refresh", "sync"], optionAliases: { json: ["--json", "-j"] }, required: [] },
];

const FALLBACK_JSON: CodeGraphDialect["jsonFlags"] = {
  search: "--json",
  symbol: "--json",
  callers: "--json",
  callees: "--json",
  impact: "--json",
  affected: "--json",
  refresh: "--json",
};

export const FALLBACK_CODEGRAPH_DIALECT: CodeGraphDialect = {
  init: ["init", "--json"],
  searchCommand: "search",
  jsonFlag: "--json",
  jsonFlags: FALLBACK_JSON,
  limitFlag: "--limit",
  symbolCommand: "symbol",
  callersCommand: "callers",
  calleesCommand: "callees",
  impactCommand: "impact",
  impactDepthFlag: "--depth",
  impactSymbolFlag: "--symbol",
  impactFileFlag: "--file",
  affectedCommand: "affected-tests",
  affectedFileFlag: "--file",
  refreshCommand: "refresh",
};

/**
 * Probe CodeGraph CLI availability, version, and FTS5 support.
 * Native bindings are out of A10 scope; this gate informs later blocks.
 */
export async function probeCodeGraph(
  binary = "codegraph",
  cwd = process.cwd(),
): Promise<CodeGraphProbeResult> {
  return probeCodeGraphContract(binary, cwd);
}

/**
 * Additive CLI contract probe. Compatibility is based on help-discovered capabilities,
 * not on the fake CLI's version or behavior.
 */
export async function probeCodeGraphContract(
  binary = "codegraph",
  cwd = process.cwd(),
  options: CodeGraphContractProbeOptions = {},
): Promise<CodeGraphProbeResult> {
  try {
    const versionRun = await runProcess({
      argv: [binary, "--version"],
      cwd,
      env: DEFAULT_ENV,
      timeoutMs: 5_000,
      maxOutputBytes: 64_000,
    });
    if (versionRun.exitCode !== 0 || versionRun.timedOut || versionRun.aborted || versionRun.signal !== null) {
      // some CLIs use `version` subcommand
      const alt = await runProcess({
        argv: [binary, "version"],
        cwd,
        env: DEFAULT_ENV,
        timeoutMs: 5_000,
        maxOutputBytes: 64_000,
      });
      if (alt.exitCode !== 0 || alt.timedOut || alt.aborted || alt.signal !== null) {
        return {
          available: false,
          version: null,
          fts5: false,
          nativeEligible: false,
          compatible: false,
          reason: `codegraph version failed: ${versionRun.stderr.slice(0, 200) || alt.stderr.slice(0, 200) || "signal/non-zero exit"}`,
        };
      }
      return await interpretProbe(binary, cwd, (alt.stdout || alt.stderr).trim(), options);
    }
    return await interpretProbe(binary, cwd, (versionRun.stdout || versionRun.stderr).trim(), options);
  } catch (err) {
    return {
      available: false,
      version: null,
      fts5: false,
      nativeEligible: false,
      compatible: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function interpretProbe(
  binary: string,
  cwd: string,
  versionText: string,
  options: CodeGraphContractProbeOptions,
): Promise<CodeGraphProbeResult> {
  const versionMatch = versionText.split(/\s+/).find((t) => /^\d+\.\d+/.test(t));
  const version = versionMatch ?? (versionText.slice(0, 64) || null);

  let fts5 = false;
  let reason: string | undefined;
  try {
    const probe = await runProcess({
      argv: [binary, "probe", "--json"],
      cwd,
      env: DEFAULT_ENV,
      timeoutMs: 8_000,
      maxOutputBytes: 256_000,
    });
    if (probe.exitCode === 0 && probe.stdout.trim()) {
      const parsed = JSON.parse(probe.stdout) as { fts5?: boolean; ok?: boolean };
      fts5 = parsed.fts5 === true;
      if (!fts5) reason = "FTS5 unavailable";
    } else {
      // Older CLIs may lack probe; treat FTS5 as unknown/false for native eligibility.
      reason = "probe subcommand unavailable or failed; FTS5 not confirmed";
    }
  } catch {
    reason = "probe failed";
  }

  const contract = await discoverContract(binary, cwd, options);
  const dialect = dialectFromDiscovered(contract.chosen);
  const compatible = contract.missing.length === 0 && contract.fixtureQuery === "passed";
  if (!compatible) {
    const compatibilityReason = `incompatible CLI contract: ${contract.missing.join(", ") || "fixture query failed"}`;
    reason = reason === undefined ? compatibilityReason : `${reason}; ${compatibilityReason}`;
  }
  return {
    available: true,
    version,
    fts5,
    nativeEligible: fts5,
    compatible,
    contract: {
      contractVersion: 1,
      helpDiscovered: contract.helpDiscovered,
      commands: contract.commands,
      missing: contract.missing,
      fixtureQuery: contract.fixtureQuery,
    },
    dialect,
    ...(reason !== undefined ? { reason } : {}),
  };
}

async function discoverContract(
  binary: string,
  cwd: string,
  options: CodeGraphContractProbeOptions,
): Promise<{
  helpDiscovered: boolean;
  commands: Record<string, CodeGraphCommandCapability>;
  missing: string[];
  fixtureQuery: "not-run" | "passed" | "failed";
  chosen: Record<string, { command: string; options: Record<string, string | null> }>;
}> {
  const rootHelp = await getHelp(binary, cwd, []);
  const commands: Record<string, CodeGraphCommandCapability> = {};
  const missing: string[] = [];
  const chosen: Record<string, { command: string; options: Record<string, string | null> }> = {};

  for (const spec of LOGICAL_COMMANDS) {
    // Discover the alias by actually invoking `<alias> --help`. Scanning root help
    // prose matches words like "symbol" / "search" that are not commands.
    let alias: string | undefined;
    let help: { ok: boolean; text: string } = { ok: false, text: "" };
    for (const name of spec.aliases) {
      const candidate = await getHelp(binary, cwd, [name]);
      if (candidate.ok) {
        alias = name;
        help = candidate;
        break;
      }
    }
    const available = alias !== undefined && help.ok;
    const discoveredOptions: Record<string, boolean> = {};
    const chosenOptions: Record<string, string | null> = {};
    for (const [key, flags] of Object.entries(spec.optionAliases)) {
      const flag = flags.find((token) => available && containsToken(help.text, token)) ?? null;
      discoveredOptions[key] = flag !== null;
      chosenOptions[key] = flag;
    }
    commands[spec.logical] = { available, options: discoveredOptions };
    if (!available) missing.push(`command:${spec.logical}`);
    for (const key of spec.required) {
      if (!discoveredOptions[key]) missing.push(`${spec.logical}:${key}`);
    }
    chosen[spec.logical] = { command: alias ?? spec.aliases[0]!, options: chosenOptions };
  }

  let fixtureQuery: "not-run" | "passed" | "failed";
  if (options.fixtureQuery !== undefined) {
    fixtureQuery = await runFixtureQuery(binary, cwd, options.fixtureQuery, chosen);
  } else {
    fixtureQuery = await runIsolatedFixtureQuery(binary, chosen);
  }

  return {
    helpDiscovered: rootHelp.ok,
    commands,
    missing,
    fixtureQuery,
    chosen,
  };
}

function dialectFromDiscovered(
  chosen: Record<string, { command: string; options: Record<string, string | null> }>,
): CodeGraphDialect {
  const json = (logical: string): "--json" | "-j" | null => {
    const flag = chosen[logical]?.options["json"];
    return flag === "--json" || flag === "-j" ? flag : null;
  };
  const limit = chosen["search"]?.options["limit"];
  const depth = chosen["impact"]?.options["depth"];
  const jsonFlags = {
    search: json("search"),
    symbol: json("symbol"),
    callers: json("callers"),
    callees: json("callees"),
    impact: json("impact"),
    affected: json("affected-tests"),
    refresh: json("refresh"),
  };
  const initJson = json("init");
  return {
    init: initJson ? ["init", initJson] : ["init"],
    searchCommand: chosen["search"]?.command ?? "search",
    jsonFlag: jsonFlags.search,
    jsonFlags,
    limitFlag: limit === "--limit" || limit === "-l" ? limit : null,
    symbolCommand: chosen["symbol"]?.command ?? "symbol",
    callersCommand: chosen["callers"]?.command ?? "callers",
    calleesCommand: chosen["callees"]?.command ?? "callees",
    impactCommand: chosen["impact"]?.command ?? "impact",
    impactDepthFlag: depth === "--depth" || depth === "-d" ? depth : null,
    impactSymbolFlag: chosen["impact"]?.options["symbol"] === "--symbol" ? "--symbol" : null,
    impactFileFlag: chosen["impact"]?.options["file"] === "--file" ? "--file" : null,
    affectedCommand: chosen["affected-tests"]?.command ?? "affected-tests",
    affectedFileFlag: chosen["affected-tests"]?.options["file"] === "--file" ? "--file" : null,
    refreshCommand: chosen["refresh"]?.command ?? "refresh",
  };
}

export function dialectFromProbe(probe: CodeGraphProbeResult): CodeGraphDialect {
  return probe.dialect ?? FALLBACK_CODEGRAPH_DIALECT;
}

async function runIsolatedFixtureQuery(
  binary: string,
  chosen: Record<string, { command: string; options: Record<string, string | null> }>,
): Promise<"passed" | "failed"> {
  const root = mkdtempSync(join(tmpdir(), "polish-codegraph-contract-"));
  const expectedPath = "src/polish-contract-probe.ts";
  const marker = "POLISH_CODEGRAPH_CONTRACT_MARKER_7f31";
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, expectedPath), `export const marker = "${marker}";\n`);
    const initArgv = dialectFromDiscovered(chosen).init;
    const init = await runProcess({
      argv: [binary, ...initArgv],
      cwd: root,
      env: DEFAULT_ENV,
      timeoutMs: 8_000,
      maxOutputBytes: 256_000,
    });
    if (init.exitCode !== 0 || init.timedOut || init.aborted || init.signal !== null) return "failed";
    return await runFixtureQuery(binary, root, { query: marker, expectedPath, limit: 1 }, chosen);
  } catch {
    return "failed";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runFixtureQuery(
  binary: string,
  cwd: string,
  fixture: NonNullable<CodeGraphContractProbeOptions["fixtureQuery"]>,
  chosen: Record<string, { command: string; options: Record<string, string | null> }>,
): Promise<"passed" | "failed"> {
  try {
    const dialect = dialectFromDiscovered(chosen);
    const argv = [binary, dialect.searchCommand, fixture.query];
    if (dialect.jsonFlag) argv.push(dialect.jsonFlag);
    if (dialect.limitFlag) argv.push(dialect.limitFlag, String(fixture.limit ?? 1));
    const query = await runProcess({
      argv,
      cwd,
      env: DEFAULT_ENV,
      timeoutMs: 8_000,
      maxOutputBytes: 256_000,
    });
    const parsed = JSON.parse(query.stdout) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { hits?: unknown }).hits)
        ? (parsed as { hits: unknown[] }).hits
        : Array.isArray((parsed as { results?: unknown }).results)
          ? (parsed as { results: unknown[] }).results
          : [];
    return query.exitCode === 0 &&
      rows.length > 0 &&
      (fixture.expectedPath === undefined ||
        rows.some((row) => {
          const path = (row as { path?: unknown; file?: unknown }).path ?? (row as { file?: unknown }).file;
          return path === fixture.expectedPath;
        }))
      ? "passed"
      : "failed";
  } catch {
    return "failed";
  }
}

async function getHelp(
  binary: string,
  cwd: string,
  prefix: readonly string[],
): Promise<{ ok: boolean; text: string }> {
  try {
    const run = await runProcess({
      argv: [binary, ...prefix, "--help"],
      cwd,
      env: DEFAULT_ENV,
      timeoutMs: 5_000,
      maxOutputBytes: 256_000,
    });
    return {
      ok: run.exitCode === 0 && !run.timedOut && !run.aborted && run.signal === null,
      text: `${run.stdout}\n${run.stderr}`,
    };
  } catch {
    return { ok: false, text: "" };
  }
}

function containsToken(help: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|\\s|,|\\||\\[)${escaped}(?=$|\\s|,|\\||=|\\]|<|>)`,
    "m",
  ).test(help);
}
