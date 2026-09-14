import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MISSING_DEPENDENCIES_REASON, untrustedForMissingDependencies } from "./projectDependencies.js";

describe("untrustedForMissingDependencies", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function project(manifest: Record<string, unknown>, options: { installed?: boolean } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "polish-deps-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    if (options.installed === true) mkdirSync(join(dir, "node_modules"));
    return dir;
  }

  it("flags a manifest that declares dependencies with none installed", () => {
    const dir = project({ name: "x", devDependencies: { vitest: "^4" } });
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "test"])).toBe(MISSING_DEPENDENCIES_REASON);
  });

  it("counts every dependency field, not only dependencies", () => {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const dir = project({ name: "x", [field]: { left: "^1" } });
      expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "build"]), field).toBe(MISSING_DEPENDENCIES_REASON);
    }
  });

  it("does not flag a project that declares no dependencies and needs none", () => {
    // fixtures/resume-dup-fetch is exactly this: `pnpm run test` -> `node --test`.
    const dir = project({ name: "x", scripts: { test: "node --test tests/a.test.mjs" } });
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "test"], "node --test tests/a.test.mjs")).toBeNull();
  });

  it("still flags a command that needs packages even when the manifest declares none", () => {
    const dir = project({ name: "x", scripts: { test: "vitest run" } });
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "test"], "vitest run")).toBe(MISSING_DEPENDENCIES_REASON);
  });

  it("does not flag once the packages are installed", () => {
    const dir = project({ name: "x", devDependencies: { vitest: "^4" } }, { installed: true });
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "test"], "vitest run")).toBeNull();
  });

  it("does not flag a directory with no manifest at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-deps-"));
    cleanup.push(dir);
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "test"])).toBeNull();
  });

  it("treats an unreadable manifest as declaring nothing rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-deps-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(untrustedForMissingDependencies(dir, ["node", "--test"])).toBeNull();
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "test"], "vitest run")).toBe(MISSING_DEPENDENCIES_REASON);
  });
});
