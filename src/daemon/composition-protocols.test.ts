import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { defaultConfig } from "../domain/config.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { PolishError } from "../shared/errors.js";
import { openStore, type Store } from "../store/index.js";
import { buildProductionDeps } from "./composition.js";

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function brokenProtocols(): { root: string; skillPath: string } {
  const root = tmp("polish-broken-protocols-");
  mkdirSync(join(root, "bugfix"), { recursive: true });
  const skillPath = join(root, "bugfix", "SKILL.md");
  writeFileSync(
    skillPath,
    `---
name: feature
description: declares a name its folder does not have
applies_to:
  - worker
kind: task
budget_tokens: 10
resources: []
---

# feature

body
`,
    "utf8",
  );
  return { root, skillPath };
}

describe("buildProductionDeps protocol load diagnostic", () => {
  let store: Store;
  let clock: FakeClock;
  let home: string;
  let stderr: MockInstance<typeof process.stderr.write>;
  let lines: string[];

  beforeEach(() => {
    home = tmp("polish-deps-home-");
    store = openStore({ artifactsDir: join(home, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
    lines = [];
    stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderr.mockRestore();
    store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function build(protocolsRoot: string): void {
    buildProductionDeps({
      store,
      clock,
      config: defaultConfig(),
      home,
      providers: [new ScriptedProvider("scripted", [{ name: "worker", capabilities: FAKE_CAPABILITIES.frontier }])],
      protocolsRoot,
    });
  }

  it("throws a PolishError naming the code and the offending absolute SKILL.md path", () => {
    const { root, skillPath } = brokenProtocols();
    let thrown: unknown;
    try {
      build(root);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PolishError);
    const error = thrown as PolishError;
    expect(error.code).toBe("INVARIANT_VIOLATION");
    // Equality, not containment: `toContain` of the prefix and of the path separately leaves the
    // text between them free, so a wrapper that wrote `near <path>` would satisfy both.
    expect(error.message).toBe(
      `protocol registry failed to load: INVARIANT_VIOLATION at ${skillPath}: `
      + 'protocol name "feature" must match directory "bugfix"',
    );
  });

  it("reports an unreadable protocols root as IO_ERROR against the root path", () => {
    const root = tmp("polish-unreadable-protocols-");
    chmodSync(root, 0o000);
    let thrown: unknown;
    try {
      build(root);
    } catch (error) {
      thrown = error;
    } finally {
      chmodSync(root, 0o755);
    }
    expect(thrown).toBeInstanceOf(PolishError);
    expect((thrown as PolishError).code).toBe("IO_ERROR");
    expect((thrown as PolishError).message).toContain(`protocol registry failed to load: IO_ERROR at ${root}`);
  });

  /**
   * MC3 and MC5 are claims about code that is not there, so both are observed over the source.
   * `productionSources` is shared by the two checks below.
   */
  function productionSources(): { src: string; files: string[] } {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const files = readdirSync(src, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
    return { src, files };
  }

  it("has exactly one owner of the operator line", () => {
    const { src, files } = productionSources();
    const owners = files.filter((path) => readFileSync(path, "utf8").includes("protocol registry failed to load"));
    expect(owners).toEqual([join(src, "daemon", "composition.ts")]);
  });

  /**
   * The wording of a second wrapper is free, so counting the diagnostic literal cannot see one.
   * The call sites can: any wrapper around either load rewrites the line the load sits on.
   */
  it("wraps ProtocolRegistry.load at exactly one call site", () => {
    const { src, files } = productionSources();
    const sites = files.flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.includes("ProtocolRegistry.load("))
        .map((line) => `${relative(src, path)} | ${line.trim()}`),
    );
    expect(sites).toEqual([
      "daemon/composition.ts | return ProtocolRegistry.load(root);",
      "engine/reviewDrivers.ts | const protocols = options.protocols ?? ProtocolRegistry.load(defaultProtocolsRoot());",
    ]);
  });

  /**
   * A bare `toThrow()` would also pass for a wrapper that swallowed the failure and threw something
   * unrelated later, and it would not notice deps being returned with an empty registry.
   */
  it("fails closed: no deps are produced", () => {
    const { root } = brokenProtocols();
    let produced: unknown = "not assigned";
    expect(() => {
      produced = buildProductionDeps({
        store,
        clock,
        config: defaultConfig(),
        home,
        providers: [new ScriptedProvider("scripted", [{ name: "worker", capabilities: FAKE_CAPABILITIES.frontier }])],
        protocolsRoot: root,
      });
    }).toThrow(PolishError);
    expect(produced).toBe("not assigned");
  });

  it("writes exactly one stderr line, equal to the thrown message", () => {
    const { root } = brokenProtocols();
    let thrown: unknown;
    try {
      build(root);
    } catch (error) {
      thrown = error;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`${(thrown as PolishError).message}\n`);
  });

  it("reports a missing protocols root against the root path", () => {
    const root = join(tmp("polish-absent-protocols-"), "absent");
    let thrown: unknown;
    try {
      build(root);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as PolishError).code).toBe("NOT_FOUND");
    expect((thrown as PolishError).message).toContain(`protocol registry failed to load: NOT_FOUND at ${root}`);
  });

  it("writes nothing to stderr and returns deps when the protocols root is sound", () => {
    const deps = buildProductionDeps({
      store,
      clock,
      config: defaultConfig(),
      home,
      providers: [new ScriptedProvider("scripted", [{ name: "worker", capabilities: FAKE_CAPABILITIES.frontier }])],
    });
    expect(lines).toEqual([]);
    expect(deps.protocols.has("base-engineering-policy")).toBe(true);
  });
});
