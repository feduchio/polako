import { runProcess } from "../sandbox/process.js";
import type { CodeGraphProbeResult } from "./types.js";

const DEFAULT_ENV: Record<string, string> = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
  HOME: process.env["HOME"] ?? "",
  LANG: process.env["LANG"] ?? "C",
};

/**
 * Probe CodeGraph CLI availability, version, and FTS5 support.
 * Native bindings are out of A10 scope; this gate informs later blocks.
 */
export async function probeCodeGraph(
  binary = "codegraph",
  cwd = process.cwd(),
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
          reason: `codegraph version failed: ${versionRun.stderr.slice(0, 200) || alt.stderr.slice(0, 200) || "signal/non-zero exit"}`,
        };
      }
      return await interpretProbe(binary, cwd, (alt.stdout || alt.stderr).trim());
    }
    return await interpretProbe(binary, cwd, (versionRun.stdout || versionRun.stderr).trim());
  } catch (err) {
    return {
      available: false,
      version: null,
      fts5: false,
      nativeEligible: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function interpretProbe(binary: string, cwd: string, versionText: string): Promise<CodeGraphProbeResult> {
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
  return {
    available: true,
    version,
    fts5,
    nativeEligible: fts5,
    ...(reason !== undefined ? { reason } : {}),
  };
}
