import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PolishError } from "../shared/errors.js";
import { runProcess } from "../sandbox/process.js";
import { probeCodeGraph, dialectFromProbe, FALLBACK_CODEGRAPH_DIALECT } from "./probe.js";
import type {
  CodeGraphDialect,
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
  private dialect: CodeGraphDialect = FALLBACK_CODEGRAPH_DIALECT;
  private dialectResolved = false;

  constructor(
    readonly workspacePath: string,
    private readonly options: CodeGraphCliOptions = {},
  ) {
    this.binary = options.binary ?? "codegraph";
  }

  async prepare(): Promise<void> {
    await this.resolveDialect();
    const result = await this.exec([...this.dialect.init]);
    if (result.exitCode !== 0) {
      this.lastError = result.stderr || result.stdout || "init failed";
      throw new PolishError("IO_ERROR", `codegraph init failed: ${this.lastError}`);
    }
    this.stale = false;
    this.lastError = null;
  }

  async explore(query: string, limit = 50): Promise<IntelHit[]> {
    await this.resolveDialect();
    const argv = [this.dialect.searchCommand, query];
    const searchJson = this.dialect.jsonFlags.search ?? this.dialect.jsonFlag;
    if (searchJson) argv.push(searchJson);
    if (this.dialect.limitFlag) argv.push(this.dialect.limitFlag, String(limit));
    const raw = await this.execJson(argv);
    return normalizeHits(raw);
  }

  async symbol(name: string): Promise<SymbolRef[]> {
    await this.resolveDialect();
    if (!this.dialect.jsonFlags.symbol) return [];
    const argv = [this.dialect.symbolCommand, name];
    argv.push(this.dialect.jsonFlags.symbol);
    const raw = await this.execJson(argv);
    return normalizeSymbols(raw, name);
  }

  async callers(name: string): Promise<SymbolRef[]> {
    await this.resolveDialect();
    if (!this.dialect.jsonFlags.callers) return [];
    const argv = [this.dialect.callersCommand, name];
    argv.push(this.dialect.jsonFlags.callers);
    const raw = await this.execJson(argv);
    return normalizeSymbols(raw, name, "caller");
  }

  async callees(name: string): Promise<SymbolRef[]> {
    await this.resolveDialect();
    if (!this.dialect.jsonFlags.callees) return [];
    const argv = [this.dialect.calleesCommand, name];
    argv.push(this.dialect.jsonFlags.callees);
    const raw = await this.execJson(argv);
    return normalizeSymbols(raw, name, "callee");
  }

  async impact(query: ImpactQuery, depth = 2): Promise<ImpactResult> {
    await this.resolveDialect();
    if (!this.dialect.jsonFlags.impact) {
      return { files: [], symbols: query.symbol ? [query.symbol] : [], depth, ...(this.stale ? { stale: true } : {}) };
    }
    const argv = [this.dialect.impactCommand];
    argv.push(this.dialect.jsonFlags.impact);
    if (this.dialect.impactDepthFlag) argv.push(this.dialect.impactDepthFlag, String(depth));
    if (query.symbol) {
      if (this.dialect.impactSymbolFlag) argv.push(this.dialect.impactSymbolFlag, query.symbol);
      else argv.push(query.symbol);
    }
    for (const f of query.files ?? []) {
      if (this.dialect.impactFileFlag) argv.push(this.dialect.impactFileFlag, f);
      else argv.push(f);
    }
    const raw = await this.execJson(argv);
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
    await this.resolveDialect();
    if (!this.dialect.jsonFlags.affected) return [];
    const argv = [this.dialect.affectedCommand];
    argv.push(this.dialect.jsonFlags.affected);
    for (const f of files) {
      if (this.dialect.affectedFileFlag) argv.push(this.dialect.affectedFileFlag, f);
      else argv.push(f);
    }
    const raw = await this.execJson(argv);
    if (Array.isArray(raw)) return raw.map(String).sort();
    if (Array.isArray((raw as { tests?: unknown }).tests)) {
      return ((raw as { tests: string[] }).tests).map(String).sort();
    }
    return [];
  }

  async refresh(changedFiles: readonly string[]): Promise<void> {
    if (changedFiles.length === 0) return;
    await this.resolveDialect();
    this.stale = true;
    const argv = [this.dialect.refreshCommand];
    if (this.dialect.jsonFlags.refresh) argv.push(this.dialect.jsonFlags.refresh);
    const result = await this.exec(argv);
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
    const compatible = probe.compatible === true;
    const ok = compatible && hasIndex && this.lastError === null && !this.stale;
    return {
      ok,
      backend: "codegraph-cli",
      detail: [
        `version=${probe.version ?? "?"}`,
        `fts5=${probe.fts5}`,
        `compatible=${String(compatible)}`,
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

  private async resolveDialect(): Promise<void> {
    if (this.dialectResolved) return;
    const probe = await (this.options.probe?.() ?? probeCodeGraph(this.binary, this.workspacePath));
    this.dialect = dialectFromProbe(probe);
    this.dialectResolved = true;
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
