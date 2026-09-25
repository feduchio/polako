import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { BasicIntel } from "./basic.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixture = join(repoRoot, "fixtures/intel-sample");

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
  it("callees only scans within the defining symbol region", async () => {
    const intel = new BasicIntel(fixture);
    await intel.prepare();
    const callees = await intel.callees("add");
    expect(callees.some((c) => c.name === "mul")).toBe(false);
  });
});
