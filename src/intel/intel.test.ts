import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { BasicIntel } from "./basic.js";
import { CodeGraphCli } from "./codegraphCli.js";
import { CompositeIntel } from "./composite.js";
import { probeCodeGraph, probeCodeGraphContract } from "./probe.js";
import type { RepositoryIntelligence } from "./types.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixture = join(repoRoot, "fixtures/intel-sample");
const fakeCg = join(repoRoot, "fixtures/bin/fake-codegraph");

describe("BasicIntel", () => {
  it("explores, resolves symbols, impact, and affected tests on the fixture", async () => {
    const intel = new BasicIntel(fixture);
    await intel.prepare();
    const hits = await intel.explore("function add");
    expect(hits.some((h) => h.path.includes("math.ts"))).toBe(true);
    const syms = await intel.symbol("add");
    expect(syms.length).toBeGreaterThan(0);
    const callers = await intel.callers("add");
    expect(callers.some((c) => c.path.includes("app.ts"))).toBe(true);
    const impact = await intel.impact({ files: ["src/math.ts"] }, 2);
    expect(impact.files).toContain("src/math.ts");
    expect(impact.files).toContain("src/app.ts");
    const tests = await intel.affectedTests(["src/math.ts"]);
    expect(tests.some((t) => t.includes("math.test"))).toBe(true);
    const health = await intel.health();
    expect(health.ok).toBe(true);
    expect(health.backend.startsWith("basic:")).toBe(true);
  });

  it("includes side-effect imports in the impact graph", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-basic-imp-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "src", "b.ts"), 'import "./a.js";\n');
    const intel = new BasicIntel(dir);
    await intel.prepare();
    const impact = await intel.impact({ files: ["src/a.ts"] }, 2);
    expect(impact.files).toContain("src/b.ts");
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["--type=rust", "-g*.ts", "--"])(
    "passes adversarial rg query %j after an explicit option terminator",
    async (query) => {
      const dir = mkdtempSync(join(tmpdir(), "polish-basic-rg-"));
      const fakeRg = join(dir, "fake-rg.mjs");
      writeFileSync(
        fakeRg,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
writeFileSync(join(process.cwd(), "rg-argv.json"), JSON.stringify(args));
process.stdout.write(JSON.stringify({
  type: "match",
  data: { path: { text: "./src/a.ts" }, line_number: 1, lines: { text: "match\\n" } }
}) + "\\n");
`,
      );
      chmodSync(fakeRg, 0o755);
      const intel = new BasicIntel(dir, { rgBinary: fakeRg });
      await intel.prepare();
      await intel.explore(query);
      const argv = JSON.parse(readFileSync(join(dir, "rg-argv.json"), "utf8")) as string[];
      const terminator = argv.indexOf("--");
      expect(terminator).toBeGreaterThan(-1);
      expect(argv[terminator + 1]).toBe(query);
      expect(argv[terminator + 2]).toBe(".");
      expect(argv.slice(0, terminator)).toContain("-F");
      rmSync(dir, { recursive: true, force: true });
    },
  );

  it("node fallback never compiles untrusted regex and stays bounded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-basic-re-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), `const q = "(a+)+$b";\n${"a".repeat(40_000)}\nexport function add() { return 1; }\n`);
    const intel = new BasicIntel(dir, { rgBinary: join(dir, "missing-rg") });
    await intel.prepare();
    expect((await intel.health()).backend).toBe("basic:node");
    const started = Date.now();
    const hits = await intel.explore("(a+)+$b", 10);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(hits.some((h) => h.text.includes("(a+)+$b"))).toBe(true);
    expect(hits.every((h) => !h.text.startsWith("a".repeat(100)))).toBe(true);
    const ticked = await new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(true);
      }, 15);
    });
    expect(ticked).toBe(true);
    const syms = await intel.symbol("add");
    expect(syms.some((s) => s.path.includes("a.ts"))).toBe(true);
    const callers = await intel.callers("add");
    expect(Array.isArray(callers)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("CodeGraphCli + probe", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("probes the fake binary and indexes only the bound workspace", async () => {
    dir = mkdtempSync(join(tmpdir(), "polish-cg-"));
    // copy minimal files
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    const other = mkdtempSync(join(tmpdir(), "polish-cg-other-"));
    mkdirSync(join(other, ".codegraph"), { recursive: true });
    writeFileSync(join(other, ".codegraph", "stolen"), "nope");

    const probe = await probeCodeGraph(fakeCg, dir);
    expect(probe.available).toBe(true);
    expect(probe.version).toContain("1.1.6");
    expect(probe.fts5).toBe(true);
    expect(probe.nativeEligible).toBe(true);
    expect(probe.compatible).toBe(true);
    expect(probe.contract?.helpDiscovered).toBe(true);
    expect(probe.contract?.missing).toEqual([]);
    expect(probe.contract?.fixtureQuery).toBe("passed");

    const fixtureProbe = await probeCodeGraphContract(fakeCg, dir, {
      fixtureQuery: { query: "add", expectedPath: "src/math.ts" },
    });
    expect(fixtureProbe.compatible).toBe(true);
    expect(fixtureProbe.contract?.fixtureQuery).toBe("passed");

    const cli = new CodeGraphCli(dir, { binary: fakeCg });
    await cli.prepare();
    expect(existsSync(cli.indexDir())).toBe(true);
    expect(existsSync(join(dir, ".codegraph", "ok"))).toBe(true);
    // Must not have copied other tree's index marker
    expect(existsSync(join(dir, ".codegraph", "stolen"))).toBe(false);

    const hits = await cli.explore("add");
    expect(hits[0]?.path).toBe("src/math.ts");
    const syms = await cli.symbol("add");
    expect(syms[0]?.path).toBe("src/math.ts");
    const impact = await cli.impact({ symbol: "add" }, 2);
    expect(impact.files).toContain("src/app.ts");

    await cli.refresh(["src/a.ts"]);
    const health = await cli.health();
    expect(health.ok).toBe(true);
    expect(health.backend).toBe("codegraph-cli");
    expect(health.stale).toBeUndefined();
    rmSync(other, { recursive: true, force: true });
  });

  it("marks health not ok when refresh fails and leaves the index stale", async () => {
    dir = mkdtempSync(join(tmpdir(), "polish-cg-stale-"));
    const failBin = join(dir, "fail-cg.mjs");
    writeFileSync(
      failBin,
      `#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const cmd = process.argv[2];
if (cmd === "--version" || cmd === "version") { process.stdout.write("1.0.0\\n"); process.exit(0); }
if (cmd === "probe") { process.stdout.write(JSON.stringify({ ok: true, fts5: true }) + "\\n"); process.exit(0); }
if (cmd === "init") { mkdirSync(join(process.cwd(), ".codegraph"), { recursive: true }); process.stdout.write("{}\\n"); process.exit(0); }
if (cmd === "refresh" || cmd === "sync") { process.exit(9); }
process.exit(0);
`,
    );
    chmodSync(failBin, 0o755);
    const cli = new CodeGraphCli(dir, { binary: failBin });
    await cli.prepare();
    await cli.refresh(["x.ts"]);
    const health = await cli.health();
    expect(health.stale).toBe(true);
    expect(health.ok).toBe(false);
  });

  it("health is not ok when binary is missing", async () => {
    dir = mkdtempSync(join(tmpdir(), "polish-cg-miss-"));
    const cli = new CodeGraphCli(dir, { binary: join(dir, "no-such-codegraph") });
    const health = await cli.health();
    expect(health.ok).toBe(false);
  });

  it("reports an available binary without required help capabilities as incompatible", async () => {
    dir = mkdtempSync(join(tmpdir(), "polish-cg-incompatible-"));
    const binary = join(dir, "incompatible.mjs");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const cmd = process.argv[2];
if (cmd === "--version" || cmd === "version") {
  process.stdout.write("codegraph 9.9.9\\n");
  process.exit(0);
}
if (cmd === "probe") {
  process.stdout.write('{"ok":true,"fts5":true}\\n');
  process.exit(0);
}
if (cmd === "init") {
  mkdirSync(join(process.cwd(), ".codegraph"), { recursive: true });
  process.stdout.write('{"ok":true}\\n');
  process.exit(0);
}
process.exit(2);
`,
    );
    chmodSync(binary, 0o755);
    const probe = await probeCodeGraph(binary, dir);
    expect(probe.available).toBe(true);
    expect(probe.compatible).toBe(false);
    expect(probe.contract?.helpDiscovered).toBe(false);
    expect(probe.contract?.missing).toContain("command:search");
    expect(probe.reason).toContain("incompatible CLI contract");

    const cli = new CodeGraphCli(dir, { binary });
    await cli.prepare();
    const health = await cli.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("compatible=false");
  });

  it("maps a CodeGraph 1.x query/node/affected/sync dialect from help, not fake argv", async () => {
    dir = mkdtempSync(join(tmpdir(), "polish-cg-v1-"));
    const binary = join(dir, "codegraph-v1.mjs");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const cmd = process.argv[2];
const rest = process.argv.slice(3);
const help = {
  init: "Usage: codegraph init [options] [path]\\nOptions:\\n  -f, --force",
  query: "Usage: codegraph query [options] <search>\\nOptions:\\n  -l, --limit <number>\\n  -j, --json",
  node: "Usage: codegraph node [options] [name]\\nOptions:\\n  -f, --file <file>",
  callers: "Usage: codegraph callers [options] <symbol>\\nOptions:\\n  -j, --json",
  callees: "Usage: codegraph callees [options] <symbol>\\nOptions:\\n  -j, --json",
  impact: "Usage: codegraph impact [options] <symbol>\\nOptions:\\n  -d, --depth <number>\\n  -j, --json",
  affected: "Usage: codegraph affected [options] [files...]\\nOptions:\\n  -j, --json",
  sync: "Usage: codegraph sync [options] [path]",
};
if (cmd === "--version" || cmd === "version") { process.stdout.write("1.1.6\\n"); process.exit(0); }
if (cmd === "--help") { process.stdout.write("Commands:\\n" + Object.keys(help).join("\\n") + "\\n"); process.exit(0); }
if (rest.includes("--help") && Object.hasOwn(help, cmd)) { process.stdout.write(help[cmd] + "\\n"); process.exit(0); }
if (cmd === "init") {
  mkdirSync(join(process.cwd(), ".codegraph"), { recursive: true });
  process.stdout.write("indexed\\n");
  process.exit(0);
}
if (cmd === "query") {
  process.stdout.write(JSON.stringify([{ path: "src/polish-contract-probe.ts", line: 1, text: rest[0] }]) + "\\n");
  process.exit(0);
}
process.stderr.write("unknown " + cmd + "\\n");
process.exit(2);
`,
    );
    chmodSync(binary, 0o755);
    const probe = await probeCodeGraph(binary, dir);
    expect(probe.available).toBe(true);
    expect(probe.compatible).toBe(true);
    expect(probe.dialect).toMatchObject({
      init: ["init"],
      searchCommand: "query",
      jsonFlag: "--json",
      jsonFlags: {
        search: "--json",
        symbol: null,
        callers: "--json",
        callees: "--json",
        impact: "--json",
        affected: "--json",
        refresh: null,
      },
      limitFlag: "--limit",
      symbolCommand: "node",
      affectedCommand: "affected",
      affectedFileFlag: null,
      refreshCommand: "sync",
      impactSymbolFlag: null,
      impactFileFlag: null,
    });
    expect(probe.contract?.missing).toEqual([]);
    expect(probe.contract?.fixtureQuery).toBe("passed");

    const cli = new CodeGraphCli(dir, { binary });
    await cli.prepare();
    const hits = await cli.explore("POLISH_CODEGRAPH_CONTRACT_MARKER_7f31");
    expect(hits[0]?.path).toBe("src/polish-contract-probe.ts");
    expect(await cli.symbol("add")).toEqual([]);
  });

  it("maps the installed CodeGraph binary when present", async () => {
    dir = mkdtempSync(join(tmpdir(), "polish-cg-real-"));
    const probe = await probeCodeGraph("codegraph", dir);
    if (!probe.available) return;
    expect(probe.version).toMatch(/\d+\.\d+/);
    expect(probe.dialect).toBeDefined();
    if (probe.contract?.commands["search"]?.available) {
      expect(["search", "query"]).toContain(probe.dialect?.searchCommand);
    }
    if (probe.dialect?.searchCommand === "query") {
      expect(probe.dialect.init).toEqual(["init"]);
      expect(probe.dialect.refreshCommand).toBe("sync");
      expect(probe.dialect.affectedCommand).toBe("affected");
      expect(probe.dialect.symbolCommand).toBe("node");
      expect(probe.dialect.jsonFlag === "--json" || probe.dialect.jsonFlag === "-j").toBe(true);
    }
  });
});

describe("CompositeIntel", () => {
  it("degrades to BasicIntel when primary prepare fails", async () => {
    const primary = new CodeGraphCli(fixture, { binary: join(fixture, "missing-binary") });
    const fallback = new BasicIntel(fixture);
    const composite = new CompositeIntel(fixture, {
      primary,
      fallback,
      primaryName: "codegraph-cli",
    });
    await composite.prepare();
    const health = await composite.health();
    expect(health.degradedFrom).toBe("codegraph-cli");
    expect(health.ok).toBe(true);
    const hits = await composite.explore("mul");
    expect(hits.some((h) => h.path.includes("math.ts"))).toBe(true);
  });

  it("re-checks primary health and fails over when it becomes unhealthy", async () => {
    let primaryOk = true;
    const primary: RepositoryIntelligence = {
      workspacePath: fixture,
      prepare: async () => undefined,
      explore: async () => [{ path: "primary.ts", line: 1, text: "p" }],
      symbol: async () => [],
      callers: async () => [],
      callees: async () => [],
      impact: async () => ({ files: [], symbols: [], depth: 0 }),
      affectedTests: async () => [],
      refresh: async () => undefined,
      health: async () => ({ ok: primaryOk, backend: "primary" }),
    };
    const fallback = new BasicIntel(fixture);
    const composite = new CompositeIntel(fixture, { primary, fallback, primaryName: "primary" });
    await composite.prepare();
    expect((await composite.health()).backend.startsWith("primary")).toBe(true);
    primaryOk = false;
    const health = await composite.health();
    expect(health.degradedFrom).toBe("primary");
    expect(health.ok).toBe(true);
    const hits = await composite.explore("mul");
    expect(hits.some((h) => h.path.includes("math.ts"))).toBe(true);
  });

  it("callees only scans within the defining symbol region", async () => {
    const intel = new BasicIntel(fixture);
    await intel.prepare();
    const callees = await intel.callees("add");
    expect(callees.some((c) => c.name === "mul")).toBe(false);
  });
});
