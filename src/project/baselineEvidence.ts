import type { BaselineSnapshot, CheckResult, TestSummary } from "../domain/checks.js";
import { parseTestOutput, projectRelativeLocation } from "./parsers.js";

const MAX_DIAGNOSTIC_LINES = 24;
const MAX_DIAGNOSTIC_CHARS = 4000;

export interface BaselineCheckEvidence {
  name: string;
  command: readonly string[];
  status: CheckResult["status"];
  exitCode: number | null;
  summary: TestSummary | null;
  diagnostics: string[];
  outputArtifact: { sha256: string; kind: string; bytes: number } | null;
  artifactMissing: boolean;
}

export type CheckOutputReader = (sha256: string) => string | null;

/**
 * Bounded baseline view for council intake: command/status/exit/summary plus compact
 * diagnostics. Full stdout/stderr stay in CAS behind outputArtifact.
 */
export function buildBaselineEvidenceView(
  baseline: BaselineSnapshot,
  readCheckOutput: CheckOutputReader = () => null,
): BaselineCheckEvidence[] {
  return baseline.checks.map((check) => evidenceForCheck(check, readCheckOutput));
}

function evidenceForCheck(check: CheckResult, readCheckOutput: CheckOutputReader): BaselineCheckEvidence {
  const ref = check.outputRef;
  let raw: string | null = null;
  let artifactMissing = false;
  if (ref !== null) {
    raw = readCheckOutput(ref.sha256);
    artifactMissing = raw === null;
  }
  const forensic = parseForensicCheckOutput(raw);
  const stdout = forensic?.stdout ?? (forensic === null && raw !== null && !looksLikeJson(raw) ? raw : "");
  const stderr = forensic?.stderr ?? "";
  const summary =
    check.summary ??
    (stdout.length > 0 || stderr.length > 0 ? parseTestOutput("node-test", stdout, stderr) : null);
  const sourceDiagnostics = forensic?.diagnostics ?? compactFailLines(stdout, stderr);
  const diagnostics = capDiagnostics([
    ...sourceDiagnostics.map(relativizeDiagnostic),
    ...(artifactMissing
      ? ["check_output artifact was not readable; Polish must load persisted diagnostics internally, not ask a human"]
      : []),
  ]);
  return {
    name: check.name,
    command: forensic?.command ?? [],
    status: check.status,
    exitCode: check.exitCode,
    summary,
    diagnostics,
    outputArtifact:
      ref === null ? null : { sha256: ref.sha256, kind: ref.kind, bytes: ref.bytes },
    artifactMissing,
  };
}

interface ParsedForensic {
  command: readonly string[];
  stdout: string;
  stderr: string;
  diagnostics: string[];
}

function parseForensicCheckOutput(raw: string | null): ParsedForensic | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const stdout = typeof parsed["stdout"] === "string" ? parsed["stdout"] : "";
    const stderr = typeof parsed["stderr"] === "string" ? parsed["stderr"] : "";
    const command = Array.isArray(parsed["command"])
      ? parsed["command"].filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    const diagnostics = Array.isArray(parsed["diagnostics"])
      ? parsed["diagnostics"].filter((item): item is string => typeof item === "string" && item.length > 0)
      : compactFailLines(stdout, stderr);
    return { command, stdout, stderr, diagnostics };
  } catch {
    return null;
  }
}

function looksLikeJson(raw: string): boolean {
  const trimmed = raw.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function compactFailLines(stdout: string, stderr: string): string[] {
  const text = `${stdout}\n${stderr}`.replace(/\r\n/g, "\n");
  const lines = text.split("\n").filter((line) => /fail|error|assert|expected|actual|not ok/i.test(line));
  return lines.length > 0 ? lines : [];
}

function capDiagnostics(lines: readonly string[]): string[] {
  const out: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (out.length >= MAX_DIAGNOSTIC_LINES) break;
    const next = line.length > MAX_DIAGNOSTIC_CHARS ? `${line.slice(0, MAX_DIAGNOSTIC_CHARS)}…` : line;
    if (chars + next.length > MAX_DIAGNOSTIC_CHARS) {
      const remaining = MAX_DIAGNOSTIC_CHARS - chars;
      if (remaining > 16) out.push(`${next.slice(0, remaining)}…`);
      break;
    }
    out.push(next);
    chars += next.length + 1;
  }
  return out;
}

function relativizeDiagnostic(line: string): string {
  return line.replace(/file:\/\/[^\s)'"]+/g, (url) => projectRelativeLocation(url)).replace(
    /(?:\/(?:Users|home|private|tmp|var)\/|(?:[A-Za-z]:\\))[^\s'"]+?\/((?:tests|src|lib|test)\/\S+)/g,
    "$1",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
