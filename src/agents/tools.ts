import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolSpec } from "../broker/types.js";
import type { ArtifactRef } from "../domain/common.js";
import type { RepositoryIntelligence } from "../intel/types.js";
import type { CommandPolicy } from "../sandbox/allowlist.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import { PolishError } from "../shared/errors.js";
import type { ArtifactStore } from "../store/artifacts.js";
import type { AgentToolName, LoopEvidence, RequestContext } from "./types.js";

export interface AgentToolsDeps {
  sandbox: SandboxHandle;
  commandPolicy: CommandPolicy;
  intelligence: RepositoryIntelligence;
  artifacts: ArtifactStore;
  loopEvidence: LoopEvidence;
  requestContext?: RequestContext;
  redact?: (text: string) => string;
}

export interface AgentTools {
  definitions: ToolSpec[];
  execute(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** Directories a recursive listing must not walk. A checkout with dependencies is mostly these. */
const SKIP_LIST_DIRS = new Set(["node_modules", ".git", "dist", ".polish"]);
/** How much of a file `read` returns when the caller names no range. */
const DEFAULT_READ_LINES = 400;

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const AGENT_TOOL_DEFINITIONS: ToolSpec[] = [
  { name: "read", description: "Read a UTF-8 file in the worktree.", parameters: objectSchema({ path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, ["path"]) },
  { name: "list", description: "List files and directories inside the worktree.", parameters: objectSchema({ path: { type: "string" }, recursive: { type: "boolean" } }) },
  { name: "search", description: "Search worktree text with ripgrep.", parameters: objectSchema({ query: { type: "string" }, path: { type: "string" } }, ["query"]) },
  { name: "repo_intel", description: "Query repository symbols, relationships, impact, tests, or health.", parameters: objectSchema({ action: { type: "string", enum: ["explore", "symbol", "callers", "callees", "impact", "affected_tests", "health"] }, query: { type: "string" }, files: { type: "array", items: { type: "string" } }, depth: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, ["action"]) },
  { name: "write", description: "Write a UTF-8 file inside the worktree.", parameters: objectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]) },
  { name: "apply_patch", description: "Replace one exact text fragment in a worktree file.", parameters: objectSchema({ path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, ["path", "oldText", "newText"]) },
  { name: "run_command", description: "Run an argv command allowed by the command policy.", parameters: objectSchema({ argv: { type: "array", items: { type: "string" }, minItems: 1 }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 1 } }, ["argv"]) },
  { name: "request_context", description: "Request additional task or repository context.", parameters: objectSchema({ query: { type: "string" } }, ["query"]) },
  {
    name: "finish",
    description:
      "Finish with a summary after producing fresh loop evidence. An investigation finishes with reproduction.argv: " +
      "the command that fails on this checkout if the finding is real and passes if it is not; the engine re-runs it itself. " +
      "A coding task whose acceptance already holds finishes with noChange.reason, after run_command showed a passing check; " +
      "the engine then runs the gates on the unchanged code and decides.",
    parameters: objectSchema({
      summary: { type: "string" },
      reproduction: objectSchema({ argv: { type: "array", items: { type: "string" }, minItems: 1 } }, ["argv"]),
      noChange: objectSchema({ reason: { type: "string" } }, ["reason"]),
    }, ["summary"]),
  },
];

export function createLoopEvidence(): LoopEvidence {
  return { writes: [], patches: [], commandOutputRefs: [], passedCommands: [] };
}

export function createAgentTools(deps: AgentToolsDeps): AgentTools {
  const root = realpathSync(deps.sandbox.path);
  const redact = deps.redact ?? ((text: string) => text);

  return {
    definitions: AGENT_TOOL_DEFINITIONS.map((tool) => ({ ...tool })),
    async execute(name, rawArgs, signal) {
      if (!isAgentToolName(name)) throw new PolishError("INVALID_ARGUMENT", `unknown agent tool: ${name}`);
      const args = asRecord(rawArgs);
      switch (name) {
        case "read": {
          const path = safePath(root, stringArg(args, "path"));
          const lines = readFileSync(path, "utf8").split(/\r?\n/);
          const startGiven = optionalInteger(args, "startLine");
          const endGiven = optionalInteger(args, "endLine");
          const start = startGiven ?? 1;
          const end = endGiven ?? (startGiven === undefined ? start + DEFAULT_READ_LINES - 1 : lines.length);
          const endLine = Math.min(end, lines.length);
          return {
            path: relative(root, path),
            startLine: start,
            endLine,
            totalLines: lines.length,
            truncated: start > 1 || endLine < lines.length,
            content: lines.slice(start - 1, endLine).join("\n"),
          };
        }
        case "list": {
          const path = safePath(root, optionalString(args, "path") ?? ".");
          const rel = relative(root, path) || ".";
          if (pathHitsSkippedDir(rel)) return { path: rel, entries: [], skipped: true };
          return { path: rel, entries: listEntries(root, path, args["recursive"] === true) };
        }
        case "search": {
          const query = stringArg(args, "query");
          const requested = optionalString(args, "path") ?? ".";
          safePath(root, requested);
          try {
            const result = await deps.sandbox.run(
              ["rg", "-n", "--glob", "!node_modules", "--glob", "!.git", query, requested],
              signal === undefined ? {} : { signal },
            );
            return { exitCode: result.exitCode, matches: redact(result.stdout), stderr: redact(result.stderr), truncated: result.truncated };
          } catch (error) {
            if (!isSpawnError(error, "rg")) throw error;
            const hits = await deps.intelligence.explore(query, 50);
            return { exitCode: 0, matches: redact(JSON.stringify(hits)), stderr: "", truncated: false, fallback: "repo_intel" };
          }
        }
        case "repo_intel":
          return runIntel(deps.intelligence, args);
        case "write": {
          const rel = stringArg(args, "path");
          const path = safePath(root, rel, true);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, stringArg(args, "content"), "utf8");
          deps.loopEvidence.writes.push(rel);
          return { path: relative(root, path), bytes: Buffer.byteLength(stringArg(args, "content")) };
        }
        case "apply_patch": {
          const rel = stringArg(args, "path");
          const path = safePath(root, rel);
          const before = readFileSync(path, "utf8");
          const oldText = stringArg(args, "oldText");
          const occurrences = before.split(oldText).length - 1;
          if (oldText.length === 0 || occurrences !== 1) {
            throw new PolishError("CONFLICT", `patch oldText must match exactly once (matched ${occurrences})`);
          }
          const after = before.replace(oldText, stringArg(args, "newText"));
          writeFileSync(path, after, "utf8");
          deps.loopEvidence.patches.push(rel);
          return { path: relative(root, path), bytes: Buffer.byteLength(after) };
        }
        case "run_command": {
          const argv = stringArrayArg(args, "argv");
          const denial = deps.commandPolicy.check(argv);
          if (denial !== null) throw new PolishError("SANDBOX_ERROR", denial, { argv });
          const cwd = optionalString(args, "cwd");
          if (cwd !== undefined) safePath(root, cwd);
          const opts: { signal?: AbortSignal; cwd?: string; timeoutMs?: number } = {};
          if (signal !== undefined) opts.signal = signal;
          if (cwd !== undefined) opts.cwd = cwd;
          const timeoutMs = optionalInteger(args, "timeoutMs");
          if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs;
          const result = await deps.sandbox.run(argv, opts);
          const logged = {
            ...result,
            stdout: redact(result.stdout),
            stderr: redact(result.stderr),
          };
          const outputRef = deps.artifacts.put(JSON.stringify(logged), "agent_command_output", argv.join(" "));
          deps.loopEvidence.commandOutputRefs.push(outputRef);
          if (result.exitCode === 0 && !result.timedOut) deps.loopEvidence.passedCommands.push([...argv]);
          return { ...logged, outputRef };
        }
        case "request_context": {
          const query = stringArg(args, "query");
          return deps.requestContext ? await deps.requestContext(query) : deps.intelligence.explore(query);
        }
        case "finish":
          return args;
      }
    },
  };
}

function isAgentToolName(name: string): name is AgentToolName {
  return AGENT_TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

function safePath(root: string, requested: string, allowMissing = false): string {
  if (requested.includes("\0") || isAbsolute(requested)) throw pathEscape(requested);
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw pathEscape(requested);

  const parts = rel === "" ? [] : rel.split(sep);
  let cursor = root;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw pathEscape(requested);
    } catch (error) {
      if (error instanceof PolishError) throw error;
      if (allowMissing && isMissing(error)) break;
      throw error;
    }
  }
  return target;
}

function pathEscape(path: string): PolishError {
  return new PolishError("SANDBOX_ERROR", `path escapes sandbox or traverses a symlink: ${path}`, { path });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isSpawnError(error: unknown, binary: string): boolean {
  return error instanceof Error && error.message.includes(`spawn ${binary}`);
}

function pathHitsSkippedDir(rel: string): boolean {
  return rel.split(sep).some((part) => SKIP_LIST_DIRS.has(part));
}

function listEntries(root: string, path: string, recursive: boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (SKIP_LIST_DIRS.has(entry.name)) continue;
      const full = resolve(dir, entry.name);
      out.push(relative(root, full) + (entry.isDirectory() ? "/" : ""));
      if (recursive && entry.isDirectory() && out.length < 2_000) visit(full);
      if (out.length >= 2_000) return;
    }
  };
  visit(path);
  return out.sort();
}

async function runIntel(intel: RepositoryIntelligence, args: Record<string, unknown>): Promise<unknown> {
  const action = stringArg(args, "action");
  const query = optionalString(args, "query") ?? "";
  const files = optionalStringArray(args, "files") ?? [];
  switch (action) {
    case "explore": return intel.explore(query, optionalInteger(args, "limit"));
    case "symbol": return intel.symbol(query);
    case "callers": return intel.callers(query);
    case "callees": return intel.callees(query);
    case "impact": return intel.impact(query === "" ? { files } : { symbol: query, files }, optionalInteger(args, "depth"));
    case "affected_tests": return intel.affectedTests(files);
    case "health": return intel.health();
    default: throw new PolishError("INVALID_ARGUMENT", `unknown repo_intel action: ${action}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PolishError("INVALID_ARGUMENT", "tool arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new PolishError("INVALID_ARGUMENT", `${key} must be a string`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new PolishError("INVALID_ARGUMENT", `${key} must be a string`);
  return value;
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new PolishError("INVALID_ARGUMENT", `${key} must be a positive integer`);
  return value as number;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = optionalStringArray(args, key);
  if (!value || value.length === 0) throw new PolishError("INVALID_ARGUMENT", `${key} must be a non-empty string array`);
  return value;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new PolishError("INVALID_ARGUMENT", `${key} must be a string array`);
  }
  return value;
}

export function hasLoopEvidence(evidence: LoopEvidence): boolean {
  return evidence.writes.length > 0 || evidence.patches.length > 0 || evidence.commandOutputRefs.length > 0;
}

export function loopEvidenceRefs(evidence: LoopEvidence): ArtifactRef[] {
  return [...evidence.commandOutputRefs];
}
