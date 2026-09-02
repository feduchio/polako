import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { runProcess } from "../sandbox/process.js";
import type {
  ImpactQuery,
  ImpactResult,
  IntelHealth,
  IntelHit,
  RepositoryIntelligence,
  SymbolRef,
} from "./types.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".codegraph",
  "coverage",
  ".polish",
]);

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const DEFAULT_ENV: Record<string, string> = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
  HOME: process.env["HOME"] ?? "",
  LANG: process.env["LANG"] ?? "C",
};

export interface BasicIntelOptions {
  /** Override rg binary; when missing, Node walk is used. */
  rgBinary?: string;
}

/**
 * Ripgrep/git/Node-backed intelligence that does not require CodeGraph.
 */
export class BasicIntel implements RepositoryIntelligence {
  private searchBackend: "rg" | "node" = "node";
  private prepared = false;

  constructor(
    readonly workspacePath: string,
    private readonly options: BasicIntelOptions = {},
  ) {}

  async prepare(): Promise<void> {
    this.searchBackend = (await this.rgAvailable()) ? "rg" : "node";
    this.prepared = true;
  }

  async explore(query: string, limit = 50): Promise<IntelHit[]> {
    await this.ensurePrepared();
    if (!query.trim()) return [];
    if (this.searchBackend === "rg") {
      const hits = await this.rgSearch(query, limit);
      if (hits !== null) return hits;
      this.searchBackend = "node";
    }
    return this.nodeSearch(query, limit);
  }

  async symbol(name: string): Promise<SymbolRef[]> {
    const pattern = `(?:function|class|const|let|var|type|interface|enum)\\s+${escapeRegExp(name)}\\b`;
    const hits = await this.explore(pattern, 40);
    return hits.map((h) => ({ name, path: h.path, line: h.line, kind: "symbol" }));
  }

  async callers(name: string): Promise<SymbolRef[]> {
    const hits = await this.explore(`\\b${escapeRegExp(name)}\\s*\\(`, 80);
    return hits
      .filter((h) => !new RegExp(`(?:function|const|let|var)\\s+${escapeRegExp(name)}\\b`).test(h.text))
      .map((h) => ({ name, path: h.path, line: h.line, kind: "caller" }));
  }

  async callees(name: string): Promise<SymbolRef[]> {
    // Approximate: inside files that define `name`, collect other call-like tokens — limited heuristic.
    const defs = await this.symbol(name);
    const out: SymbolRef[] = [];
    for (const def of defs.slice(0, 5)) {
      const abs = resolve(this.workspacePath, def.path);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, "utf8");
      const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const callee = m[1];
        if (callee === undefined) continue;
        if (callee === name || callee === "if" || callee === "for" || callee === "while" || callee === "switch") continue;
        const line = text.slice(0, m.index).split("\n").length;
        out.push({ name: callee, path: def.path, line, kind: "callee" });
        if (out.length >= 40) return out;
      }
    }
    return out;
  }

  async impact(query: ImpactQuery, depth = 2): Promise<ImpactResult> {
    await this.ensurePrepared();
    const seedFiles = new Set<string>(query.files ?? []);
    if (query.symbol) {
      for (const s of await this.symbol(query.symbol)) seedFiles.add(s.path);
    }
    const graph = this.buildImportGraph();
    const files = bfs(graph, [...seedFiles], depth);
    const symbols = query.symbol ? [query.symbol] : [];
    return { files, symbols, depth };
  }

  async affectedTests(files: readonly string[]): Promise<string[]> {
    await this.ensurePrepared();
    const all = listCodeFiles(this.workspacePath).filter((p) => isTestPath(p));
    const bases = files.map((f) => basenameNoExt(f));
    const hits = new Set<string>();
    for (const t of all) {
      const tb = basenameNoExt(t).replace(/\.test$/, "").replace(/\.spec$/, "");
      if (bases.some((b) => b === tb || t.includes(b))) hits.add(t);
    }
    // Also tests that import any of the files
    for (const file of files) {
      const stem = file.replace(/\.[^.]+$/, "");
      for (const t of all) {
        try {
          const text = readFileSync(resolve(this.workspacePath, t), "utf8");
          if (text.includes(stem) || text.includes(`./${basenameNoExt(file)}`) || text.includes(file)) {
            hits.add(t);
          }
        } catch {
          /* ignore */
        }
      }
    }
    return [...hits].sort();
  }

  async refresh(_changedFiles: readonly string[]): Promise<void> {
    // Stateless walk — nothing to refresh beyond re-prepare search backend.
    await this.prepare();
  }

  async health(): Promise<IntelHealth> {
    await this.ensurePrepared();
    return {
      ok: true,
      backend: `basic:${this.searchBackend}`,
      detail: this.prepared ? "ready" : "not prepared",
    };
  }

  private async ensurePrepared(): Promise<void> {
    if (!this.prepared) await this.prepare();
  }

  private async rgAvailable(): Promise<boolean> {
    const bin = this.options.rgBinary ?? "rg";
    try {
      const r = await runProcess({
        argv: [bin, "--version"],
        cwd: this.workspacePath,
        env: DEFAULT_ENV,
        timeoutMs: 3_000,
        maxOutputBytes: 8_000,
      });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }

  private async rgSearch(query: string, limit: number): Promise<IntelHit[] | null> {
    const bin = this.options.rgBinary ?? "rg";
    try {
      const r = await runProcess({
        argv: [bin, "--json", "-n", "--glob", "!node_modules/**", "--glob", "!.git/**", query, "."],
        cwd: this.workspacePath,
        env: DEFAULT_ENV,
        timeoutMs: 30_000,
        maxOutputBytes: 2_000_000,
      });
      // rg exits 1 when no matches
      if (r.exitCode !== 0 && r.exitCode !== 1) return null;
      const hits: IntelHit[] = [];
      for (const line of r.stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as {
            type?: string;
            data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
          };
          if (row.type !== "match" || !row.data?.path?.text) continue;
          hits.push({
            path: row.data.path.text.replace(/^\.\//, ""),
            line: row.data.line_number ?? 1,
            text: (row.data.lines?.text ?? "").replace(/\n$/, ""),
          });
          if (hits.length >= limit) break;
        } catch {
          /* skip bad json line */
        }
      }
      return hits;
    } catch {
      return null;
    }
  }

  private nodeSearch(query: string, limit: number): IntelHit[] {
    let re: RegExp;
    try {
      re = new RegExp(query);
    } catch {
      re = new RegExp(escapeRegExp(query));
    }
    const hits: IntelHit[] = [];
    for (const rel of listCodeFiles(this.workspacePath)) {
      const abs = resolve(this.workspacePath, rel);
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (re.test(line)) {
          hits.push({ path: rel, line: i + 1, text: line });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  private buildImportGraph(): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();
    const files = listCodeFiles(this.workspacePath);
    for (const rel of files) {
      const abs = resolve(this.workspacePath, rel);
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const imports = new Set<string>();
      const re = /from\s+["'](\.[^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const spec = m[1];
        if (spec === undefined) continue;
        const resolved = resolveImport(this.workspacePath, rel, spec);
        if (resolved) imports.add(resolved);
      }
      graph.set(rel, imports);
    }
    // reverse edges also useful for impact — add reverse as undirected for BFS
    const undirected = new Map<string, Set<string>>();
    for (const [from, tos] of graph) {
      let fromSet = undirected.get(from);
      if (fromSet === undefined) {
        fromSet = new Set();
        undirected.set(from, fromSet);
      }
      for (const to of tos) {
        fromSet.add(to);
        let toSet = undirected.get(to);
        if (toSet === undefined) {
          toSet = new Set();
          undirected.set(to, toSet);
        }
        toSet.add(from);
      }
    }
    return undirected;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listCodeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env.example") {
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        if (e.isDirectory() && e.name !== ".") {
          /* skip most dotdirs */
          if (SKIP_DIRS.has(e.name) || e.name === ".git") continue;
        }
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
        continue;
      }
      const ext = e.name.includes(".") ? `.${e.name.split(".").pop()}` : "";
      if (!CODE_EXT.has(ext)) continue;
      const abs = join(dir, e.name);
      out.push(relative(root, abs).split(sep).join("/"));
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root);
  return out.sort();
}

function isTestPath(p: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(p) || p.includes("__tests__/");
}

function basenameNoExt(p: string): string {
  const base = p.split("/").pop() ?? p;
  return base.replace(/\.[^.]+$/, "");
}

function resolveImport(workspace: string, fromRel: string, spec: string): string | null {
  const fromDir = resolve(workspace, fromRel, "..");
  const stripped = spec.replace(/\.js$/, "").replace(/\.jsx$/, "");
  const candidates = [
    spec,
    `${spec}.ts`,
    `${spec}.tsx`,
    `${spec}.js`,
    `${spec}.jsx`,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.js`,
    join(stripped, "index.ts"),
    join(stripped, "index.js"),
    join(spec, "index.ts"),
    join(spec, "index.js"),
  ];
  for (const c of candidates) {
    const abs = resolve(fromDir, c);
    if (existsSync(abs) && abs.startsWith(resolve(workspace) + sep)) {
      return relative(workspace, abs).split(sep).join("/");
    }
  }
  return null;
}

function bfs(graph: Map<string, Set<string>>, seeds: string[], depth: number): string[] {
  const seen = new Set<string>();
  let frontier = seeds.filter((s) => s.length > 0);
  for (const s of frontier) seen.add(s);
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const n of graph.get(f) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return [...seen].sort();
}
