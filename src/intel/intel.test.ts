import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { BasicIntel } from "./basic.js";
import { CodeGraphCli } from "./codegraphCli.js";
import { CompositeIntel } from "./composite.js";
import { probeCodeGraph } from "./probe.js";
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
if (cmd === "refresh") { process.exit(9); }
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
});
