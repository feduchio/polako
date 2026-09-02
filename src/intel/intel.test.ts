import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { BasicIntel } from "./basic.js";
import { CodeGraphCli } from "./codegraphCli.js";
import { CompositeIntel } from "./composite.js";
import { probeCodeGraph } from "./probe.js";

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

    rmSync(other, { recursive: true, force: true });
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
});
