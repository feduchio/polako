import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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
import { anchorOf, applyHashlineEdits, NoopTracker, parseEdits, renderAnchored } from "./hashline.js";
import { testApiDenial } from "./testApiGuard.js";
import type { AgentToolName, LoopEvidence, RequestContext } from "./types.js";

export interface AgentToolsDeps {
  sandbox: SandboxHandle;
  commandPolicy: CommandPolicy;
  intelligence: RepositoryIntelligence;
  artifacts: ArtifactStore;
  loopEvidence: LoopEvidence;
  requestContext?: RequestContext;
  redact?: (text: string) => string;
  /** How many tokens one tool result may occupy; longer text is returned a page at a time. */
  resultTokens: number;
  /** The project's test framework (`ProjectProfile.framework`), for refusing test files it cannot run. */
  testFramework?: string;
}

export interface AgentTools {
  definitions: ToolSpec[];
  execute(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  /** Store `text` and return its first page, readable further with `read_output`. */
  page(text: string, label: string): PagedText;
}

/**
 * A window onto longer text. `endLine` is the last line actually returned and `nextStartLine` is
 * present exactly when more follows, so nothing is ever cut without the caller being told where.
 */
export interface TextPage {
  startLine: number;
  endLine: number;
  totalLines: number;
  nextStartLine?: number;
  content: string;
  /** The one line shown is longer than a page; only its first `shownChars` characters are here. */
  partialLine?: { line: number; shownChars: number; totalChars: number };
}

export type PagedText = TextPage & { outputRef?: string };

/** Never the project's own source: git's store, installed dependencies, and Polish's scratch. */
const SKIP_LIST_DIRS = new Set([".git", "node_modules", ".polish"]);
/** Room left in a page for the fields around its content. */
const PAGE_ENVELOPE_TOKENS = 200;

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const AGENT_TOOL_DEFINITIONS: ToolSpec[] = [
  {
    name: "read",
    description:
      "Read a UTF-8 file in the worktree. Each line comes as `N:hh|text`: `N:hh` is the line's anchor for edit, and the text after `|` is the line. " +
      "The whole file when it fits; otherwise a page, with nextStartLine to continue from.",
    parameters: objectSchema({ path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, ["path"]),
  },
  { name: "list", description: "List files and directories git knows about or would add (ignored files are left out).", parameters: objectSchema({ path: { type: "string" }, recursive: { type: "boolean" } }) },
  { name: "search", description: "Search worktree text with ripgrep.", parameters: objectSchema({ query: { type: "string" }, path: { type: "string" } }, ["query"]) },
  { name: "repo_intel", description: "Query repository symbols, relationships, impact, tests, or health.", parameters: objectSchema({ action: { type: "string", enum: ["explore", "symbol", "callers", "callees", "impact", "affected_tests", "health"] }, query: { type: "string" }, files: { type: "array", items: { type: "string" } }, depth: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, ["action"]) },
  { name: "write", description: "Write a UTF-8 file inside the worktree.", parameters: objectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]) },
  {
    name: "edit",
    description:
      "Change lines of an existing file by the anchors read showed (the `N:hh` before `|`), without retyping them. " +
      "Each edit is {op:\"replace\", start, end?, lines} (lines start..end become lines), {op:\"insert_after\", start, lines} (start \"0\" = top of file) " +
      "or {op:\"delete\", start, end?}. All anchors refer to the file as you last read it; a line that changed since is refused, so read again. " +
      "lines are the new lines without anchors. Returns the changed lines with fresh anchors. Use write for a new file.",
    parameters: objectSchema({
      path: { type: "string" },
      edits: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          op: { type: "string", enum: ["replace", "insert_after", "delete"] },
          start: { type: "string" },
          end: { type: "string" },
          lines: { type: "array", items: { type: "string" } },
        }, ["op", "start"]),
      },
    }, ["path", "edits"]),
  },
  { name: "run_command", description: "Run an argv command allowed by the command policy.", parameters: objectSchema({ argv: { type: "array", items: { type: "string" }, minItems: 1 }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 1 } }, ["argv"]) },
  { name: "request_context", description: "Request additional task or repository context.", parameters: objectSchema({ query: { type: "string" } }, ["query"]) },
  { name: "read_output", description: "Read more of a paged tool output by its outputRef.", parameters: objectSchema({ ref: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, ["ref"]) },
  {
    name: "request_split",
    description:
      "End this attempt without finishing: the task is too large for one change. Propose at least two parts, each with a title, " +
      "acceptance criteria and the files it touches. Your edits are discarded; the council re-plans the task from your parts.",
    parameters: objectSchema({
      reason: { type: "string" },
      parts: {
        type: "array",
        minItems: 2,
        items: objectSchema({
          title: { type: "string" },
          acceptance: { type: "array", items: { type: "string" }, minItems: 1 },
          files: { type: "array", items: { type: "string" } },
        }, ["title", "acceptance"]),
      },
    }, ["reason", "parts"]),
  },
  {
    name: "finish",
    description:
      "Finish with a summary after producing fresh loop evidence. An investigation finishes with reproduction.argv: " +
      "the command that fails on this checkout if the finding is real and passes if it is not; the engine re-runs it itself. " +
      "A coding task that needed no edit, because its acceptance already held on the checkout before you changed anything, " +
      "finishes with noChange.reason after run_command showed a passing check, with no edit left in the worktree; " +
      "the engine then runs the gates on the unchanged code and decides. A task you edited finishes without noChange.",
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
  const budget = Math.max(deps.resultTokens - PAGE_ENVELOPE_TOKENS, 1);
  /** Outputs this loop stored; `read_output` reads nothing else from the artifact store. */
  const pageable = new Set<string>();
  const noops = new NoopTracker();

  const page = (text: string, label: string): PagedText => {
    const lines = splitLines(text);
    const first = pageLines(lines, 1, undefined, budget);
    if (first.nextStartLine === undefined && first.partialLine === undefined) return first;
    const ref = deps.artifacts.put(text, "agent_output_text", label);
    pageable.add(ref.sha256);
    return { ...first, outputRef: ref.sha256 };
  };

  return {
    definitions: AGENT_TOOL_DEFINITIONS.map((tool) => ({ ...tool })),
    page,
    async execute(name, rawArgs, signal) {
      if (!isAgentToolName(name)) throw new PolishError("INVALID_ARGUMENT", `unknown agent tool: ${name}`);
      const args = asRecord(rawArgs);
      switch (name) {
        case "read": {
          const path = safePath(root, stringArg(args, "path"));
          const lines = splitLines(readFileSync(path, "utf8"));
          const anchored = lines.length === 1 && lines[0] === "" ? lines : lines.map((line, index) => `${anchorOf(index + 1, line)}|${line}`);
          const window = pageLines(anchored, optionalInteger(args, "startLine") ?? 1, optionalInteger(args, "endLine"), budget);
          return { path: relative(root, path), ...window };
        }
        case "list": {
          const path = safePath(root, optionalString(args, "path") ?? ".");
          const rel = relative(root, path) || ".";
          if (pathHitsSkippedDir(rel)) return { path: rel, entryCount: 0, entries: [], skipped: true };
          const entries = await listEntries(deps.sandbox, root, rel, args["recursive"] === true);
          return { path: rel, entryCount: entries.length, ...page(entries.join("\n"), `list ${rel}`) };
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
            const matches = redact(result.stdout);
            return {
              exitCode: result.exitCode,
              matchCount: countNonEmptyLines(matches),
              ...page(matches, `search ${query}`),
              stderr: redact(result.stderr),
              processOutputCut: result.truncated,
            };
          } catch (error) {
            if (!isSpawnError(error, "rg")) throw error;
            const scan = await scanText(deps.sandbox, root, relative(root, safePath(root, requested)) || ".", query);
            const matches = redact(scan.lines.join("\n"));
            return {
              exitCode: scan.error !== null ? 2 : scan.lines.length > 0 ? 0 : 1,
              matchCount: scan.lines.length,
              ...page(matches, `search ${query}`),
              stderr: scan.error ?? "",
              fallback: "text_scan",
            };
          }
        }
        case "repo_intel":
          return runIntel(deps.intelligence, args);
        case "write": {
          const rel = stringArg(args, "path");
          const path = safePath(root, rel, true);
          const refusedTest = testApiDenial(deps.testFramework, rel, stringArg(args, "content"));
          if (refusedTest !== null) throw new PolishError("INVALID_ARGUMENT", `write refused: ${refusedTest}`);
          mkdirSync(dirname(path), { recursive: true });
          const { content, finalNewlineKept } = keepFinalNewline(path, stringArg(args, "content"));
          writeFileSync(path, content, "utf8");
          deps.loopEvidence.writes.push(rel);
          return { path: relative(root, path), bytes: Buffer.byteLength(content), ...(finalNewlineKept ? { finalNewlineKept } : {}) };
        }
        case "edit": {
          const rel = stringArg(args, "path");
          const path = safePath(root, rel);
          if (!existsSync(path)) throw new PolishError("INVALID_ARGUMENT", `${rel} does not exist; create it with write`);
          const before = readFileSync(path, "utf8");
          const edits = parseEdits(args["edits"]);
          const { after, changed } = applyHashlineEdits(before, edits);
          if (after === before) throw noops.refuse(rel, JSON.stringify(edits));
          const refusedTest = testApiDenial(deps.testFramework, rel, after);
          if (refusedTest !== null) throw new PolishError("INVALID_ARGUMENT", `edit refused: ${refusedTest}`);
          noops.reset(rel);
          writeFileSync(path, after, "utf8");
          deps.loopEvidence.patches.push(rel);
          const lines = splitLines(after);
          const from = Math.max(1, changed.from - 1);
          const to = Math.min(lines.length, changed.to + 1);
          return { path: relative(root, path), bytes: Buffer.byteLength(after), totalLines: lines.length, lines: renderAnchored(lines, from, to) };
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
          const stdout = redact(result.stdout);
          const stderr = redact(result.stderr);
          const evidenceRef = deps.artifacts.put(JSON.stringify({ ...result, stdout, stderr }), "agent_command_output", argv.join(" "));
          deps.loopEvidence.commandOutputRefs.push(evidenceRef);
          if (result.exitCode === 0 && !result.timedOut) deps.loopEvidence.passedCommands.push([...argv]);
          const text = stderr === "" ? stdout : stdout === "" ? `[stderr]\n${stderr}` : `${stdout}\n[stderr]\n${stderr}`;
          return {
            argv: result.argv,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            aborted: result.aborted,
            durationMs: result.durationMs,
            processOutputCut: result.truncated,
            ...page(text, argv.join(" ")),
          };
        }
        case "request_context": {
          const query = stringArg(args, "query");
          return deps.requestContext ? await deps.requestContext(query) : deps.intelligence.explore(query);
        }
        case "read_output": {
          const ref = stringArg(args, "ref");
          if (!pageable.has(ref)) {
            throw new PolishError("INVALID_ARGUMENT", `no paged output ${ref} in this loop; use the outputRef a tool result gave you`);
          }
          const lines = splitLines(deps.artifacts.getText(ref));
          return { outputRef: ref, ...pageLines(lines, optionalInteger(args, "startLine") ?? 1, optionalInteger(args, "endLine"), budget) };
        }
        case "request_split":
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

/**
 * What git tracks or would add under `rel`, minus ignored files and install output. A directory
 * walk showed build output and vendored trees the repository itself ignores.
 */
async function listEntries(sandbox: SandboxHandle, root: string, rel: string, recursive: boolean): Promise<string[]> {
  const files = await listedFiles(sandbox, root, rel);
  if (recursive) {
    const dirs = new Set<string>();
    for (const file of files) {
      const parts = file.split("/");
      for (let depth = 1; depth < parts.length; depth += 1) {
        const dir = parts.slice(0, depth).join("/");
        if (rel === "." || dir.length > rel.length) dirs.add(`${dir}/`);
      }
    }
    return [...files, ...dirs].sort();
  }
  const prefix = rel === "." ? "" : `${rel}/`;
  const children = new Set<string>();
  for (const file of files) {
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf("/");
    children.add(slash === -1 ? file : `${prefix}${rest.slice(0, slash)}/`);
  }
  return [...children].sort();
}

async function listedFiles(sandbox: SandboxHandle, root: string, rel: string): Promise<string[]> {
  return (await sandbox.git.listFiles(rel === "." ? "." : rel))
    .filter((file) => !pathHitsSkippedDir(file) && existsSync(resolve(root, file)));
}

/**
 * `rg -n` over the files `list` shows, for a sandbox without ripgrep. The fallback used to be a
 * symbol lookup, which answered a text query such as `add\(` with zero matches and exit 0; a
 * worker trusted it and searched again until it stalled (run_01m3dvhg6rz2c5217xqmsh).
 */
async function scanText(sandbox: SandboxHandle, root: string, rel: string, query: string): Promise<{ lines: string[]; error: string | null }> {
  let pattern: RegExp;
  try {
    pattern = new RegExp(query);
  } catch (error) {
    return { lines: [], error: `regex parse error: ${error instanceof Error ? error.message : String(error)}` };
  }
  const lines: string[] = [];
  for (const file of await listedFiles(sandbox, root, rel)) {
    const bytes = readFileSync(resolve(root, file));
    if (bytes.includes(0)) continue;
    splitLines(bytes.toString("utf8")).forEach((line, index) => {
      if (pattern.test(line)) lines.push(`${file}:${String(index + 1)}:${line}`);
    });
  }
  return { lines, error: null };
}

/**
 * A whole-file write keeps the final newline the file already ends with. Workers write files back
 * without it, and that one byte became the whole change of a mission that needed none
 * (run_01m3drb07720355x3z1s63, run_01m3dvhgf6yapa3cvhvcnx).
 */
function keepFinalNewline(path: string, content: string): { content: string; finalNewlineKept: boolean } {
  if (content === "" || content.endsWith("\n") || !existsSync(path)) return { content, finalNewlineKept: false };
  const existing = readFileSync(path, "utf8");
  if (existing.endsWith("\r\n")) return { content: `${content}\r\n`, finalNewlineKept: true };
  if (existing.endsWith("\n")) return { content: `${content}\n`, finalNewlineKept: true };
  return { content, finalNewlineKept: false };
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function countNonEmptyLines(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * Lines `start`..`end` (or to the end), as many as fit in `budgetTokens`. At least one line is
 * always returned; a single line longer than the budget is cut and says so in `partialLine`.
 */
export function pageLines(lines: readonly string[], start: number, end: number | undefined, budgetTokens: number): TextPage {
  const totalLines = lines.length;
  if (totalLines === 0 || (totalLines === 1 && lines[0] === "")) {
    return { startLine: 1, endLine: 0, totalLines: 0, content: "" };
  }
  if (start > totalLines) {
    throw new PolishError("INVALID_ARGUMENT", `startLine ${String(start)} is past the end (totalLines ${String(totalLines)})`);
  }
  const last = Math.min(end ?? totalLines, totalLines);
  if (last < start) throw new PolishError("INVALID_ARGUMENT", `endLine ${String(last)} is before startLine ${String(start)}`);
  const budgetChars = budgetTokens * 4;
  let used = 0;
  let endLine = start - 1;
  for (let line = start; line <= last; line += 1) {
    // Measured as it will travel: inside a JSON string, where a newline or a quote costs two.
    const cost = JSON.stringify(lines[line - 1] ?? "").length;
    if (endLine >= start && used + cost > budgetChars) break;
    used += cost;
    endLine = line;
  }
  const first = lines[start - 1] ?? "";
  const partial = endLine === start && JSON.stringify(first).length > budgetChars;
  const shownChars = Math.floor(budgetChars / 2);
  const content = partial ? first.slice(0, shownChars) : lines.slice(start - 1, endLine).join("\n");
  return {
    startLine: start,
    endLine,
    totalLines,
    ...(endLine < totalLines ? { nextStartLine: endLine + 1 } : {}),
    content,
    ...(partial ? { partialLine: { line: start, shownChars, totalChars: first.length } } : {}),
  };
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
