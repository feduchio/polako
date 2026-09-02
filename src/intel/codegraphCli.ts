import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PolishError } from "../shared/errors.js";
import { runProcess } from "../sandbox/process.js";
import { probeCodeGraph } from "./probe.js";
import type {
  ImpactQuery,
  ImpactResult,
  IntelHealth,
  IntelHit,
  RepositoryIntelligence,
  SymbolRef,
} from "./types.js";

const DEFAULT_ENV: Record<string, string> = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
  HOME: process.env["HOME"] ?? "",
  LANG: process.env["LANG"] ?? "C",
};

export interface CodeGraphCliOptions {
  binary?: string;
  /** Test seam: skip real probe */
  probe?: () => ReturnType<typeof probeCodeGraph>;
}

/**
 * CodeGraph CLI backend. Indexes only the bound workspace; never copies `.codegraph/`
 * from another tree.
 */
export class CodeGraphCli implements RepositoryIntelligence {
  private stale = false;
  private lastError: string | null = null;
  private readonly binary: string;

  constructor(
    readonly workspacePath: string,
    private readonly options: CodeGraphCliOptions = {},
  ) {
    this.binary = options.binary ?? "codegraph";
  }

  async prepare(): Promise<void> {
    // Never copy .codegraph from elsewhere — init in this workspace only.
    const result = await this.exec(["init", "--json"]);
    if (result.exitCode !== 0) {
      this.lastError = result.stderr || result.stdout || "init failed";
      throw new PolishError("IO_ERROR", `codegraph init failed: ${this.lastError}`);
    }
    this.stale = false;
    this.lastError = null;
  }

  async explore(query: string, limit = 50): Promise<IntelHit[]> {
    const raw = await this.execJson(["search", query, "--json", "--limit", String(limit)]);
    return normalizeHits(raw);
  }

  async symbol(name: string): Promise<SymbolRef[]> {
    const raw = await this.execJson(["symbol", name, "--json"]);
    return normalizeSymbols(raw, name);
  }

  async callers(name: string): Promise<SymbolRef[]> {
    const raw = await this.execJson(["callers", name, "--json"]);
    return normalizeSymbols(raw, name, "caller");
  }

  async callees(name: string): Promise<SymbolRef[]> {
    const raw = await this.execJson(["callees", name, "--json"]);
    return normalizeSymbols(raw, name, "callee");
  }

  async impact(query: ImpactQuery, depth = 2): Promise<ImpactResult> {
    const args = ["impact", "--json", "--depth", String(depth)];
    if (query.symbol) args.push("--symbol", query.symbol);
    for (const f of query.files ?? []) args.push("--file", f);
    const raw = await this.execJson(args);
    const files = Array.isArray((raw as { files?: unknown }).files)
      ? ((raw as { files: string[] }).files)
      : [];
    const symbols = Array.isArray((raw as { symbols?: unknown }).symbols)
      ? ((raw as { symbols: string[] }).symbols)
      : query.symbol
        ? [query.symbol]
        : [];
    return { files: files.map(String).sort(), symbols, depth, ...(this.stale ? { stale: true } : {}) };
  }

  async affectedTests(files: readonly string[]): Promise<string[]> {
    const args = ["affected-tests", "--json", ...files.flatMap((f) => ["--file", f])];
    const raw = await this.execJson(args);
    if (Array.isArray(raw)) return raw.map(String).sort();
    if (Array.isArray((raw as { tests?: unknown }).tests)) {
      return ((raw as { tests: string[] }).tests).map(String).sort();
    }
    return [];
  }

  async refresh(changedFiles: readonly string[]): Promise<void> {
    if (changedFiles.length === 0) return;
    // Mark stale; callers may re-prepare. We do not copy indexes from another worktree.
    this.stale = true;
    const args = ["refresh", "--json", ...changedFiles.flatMap((f) => ["--file", f])];
    const result = await this.exec(args);
    if (result.exitCode === 0) {
      this.stale = false;
      this.lastError = null;
      return;
    }
    this.lastError = result.stderr || result.stdout || `refresh exit ${String(result.exitCode)}`;
  }

  async health(): Promise<IntelHealth> {
    const probe = await (this.options.probe?.() ?? probeCodeGraph(this.binary, this.workspacePath));
    if (!probe.available) {
      return { ok: false, backend: "codegraph-cli", detail: probe.reason ?? "unavailable" };
    }
    const indexPath = join(this.workspacePath, ".codegraph");
    const hasIndex = existsSync(indexPath);
    const ok = hasIndex && this.lastError === null && !this.stale;
    return {
      ok,
      backend: "codegraph-cli",
      detail: [
        `version=${probe.version ?? "?"}`,
        `fts5=${probe.fts5}`,
        hasIndex ? "indexed" : "no-index",
        this.stale ? "stale" : "fresh",
        this.lastError ? `err=${this.lastError}` : null,
      ]
        .filter(Boolean)
        .join("; "),
      ...(this.stale ? { stale: true } : {}),
    };
  }

  /** Test/helper: path where this backend keeps its index (never copied across trees). */
  indexDir(): string {
    return resolve(this.workspacePath, ".codegraph");
  }

  private async exec(argv: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    try {
      const r = await runProcess({
        argv: [this.binary, ...argv],
        cwd: this.workspacePath,
        env: DEFAULT_ENV,
        timeoutMs: 60_000,
        maxOutputBytes: 4_000_000,
      });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return { exitCode: 127, stdout: "", stderr: this.lastError };
    }
  }

  private async execJson(argv: string[]): Promise<unknown> {
    const r = await this.exec(argv);
    if (r.exitCode !== 0) {
      throw new PolishError("IO_ERROR", `codegraph ${argv[0]} failed: ${r.stderr || r.stdout}`);
    }
    const text = r.stdout.trim();
    if (!text) return [];
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new PolishError("IO_ERROR", `codegraph returned invalid JSON: ${String(err)}`);
    }
  }
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback = 1): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normalizeHits(raw: unknown): IntelHit[] {
  const rows = Array.isArray(raw) ? raw : Array.isArray((raw as { hits?: unknown }).hits) ? (raw as { hits: unknown[] }).hits : [];
  return rows
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        path: asString(r["path"] ?? r["file"]),
        line: asNumber(r["line"] ?? r["line_number"], 1),
        text: asString(r["text"] ?? r["content"]),
      };
    })
    .filter((h) => h.path.length > 0);
}

function normalizeSymbols(raw: unknown, fallbackName: string, kind?: string): SymbolRef[] {
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { symbols?: unknown }).symbols)
      ? (raw as { symbols: unknown[] }).symbols
      : [];
  return rows
    .map((row) => {
      const r = row as Record<string, unknown>;
      const out: SymbolRef = {
        name: asString(r["name"], fallbackName),
        path: asString(r["path"] ?? r["file"]),
        line: asNumber(r["line"], 1),
      };
      const k = kind ?? (typeof r["kind"] === "string" ? r["kind"] : undefined);
      if (k !== undefined) out.kind = k;
      return out;
    })
    .filter((s) => s.path.length > 0);
}
