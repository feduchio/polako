import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommandFor, MISSING_DEPENDENCIES_REASON, untrustedForMissingDependencies } from "./projectDependencies.js";

describe("untrustedForMissingDependencies", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function project(manifest: Record<string, unknown>, options: { installed?: string } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "polish-deps-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    if (options.installed !== undefined) mkdirSync(join(dir, "node_modules", options.installed), { recursive: true });
    return dir;
  }

  it("flags a manifest that declares dependencies with none installed", () => {
    const dir = project({ name: "x", devDependencies: { vitest: "^4" } });
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "test"])).toBe(MISSING_DEPENDENCIES_REASON);
  });

  it("counts dependencies and devDependencies, and only those", () => {
    for (const field of ["dependencies", "devDependencies"]) {
      const dir = project({ name: "x", [field]: { left: "^1" } });
      expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "build"]), field).toBe(MISSING_DEPENDENCIES_REASON);
    }
    // optional packages may legitimately be absent after a successful install, and peers are the
    // consumer's to provide, so requiring either would refuse a correctly installed project.
    for (const field of ["optionalDependencies", "peerDependencies"]) {
      const dir = project({ name: "x", [field]: { left: "^1" } });
      expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "build"]), field).toBeNull();
    }
  });

  it("requires every declared package, because a partial install is the defect's own shape", () => {
    const dir = project({ name: "x", devDependencies: { vitest: "^4", oxlint: "^1" } }, { installed: "vitest" });
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "lint"], "oxlint src")).toBe(MISSING_DEPENDENCIES_REASON);
  });

  it("looks for the runner itself when the manifest declares nothing", () => {
    const bare = project({ name: "x", scripts: { test: "vitest run" } });
    mkdirSync(join(bare, "node_modules", "some-other-package"), { recursive: true });
    // A node_modules that exists says nothing about whether this command's binary is in it.
    expect(untrustedForMissingDependencies(bare, ["pnpm", "run", "test"], "vitest run")).toBe(MISSING_DEPENDENCIES_REASON);
    mkdirSync(join(bare, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(bare, "node_modules", ".bin", "vitest"), "#!/bin/sh\n");
    expect(untrustedForMissingDependencies(bare, ["pnpm", "run", "test"], "vitest run")).toBeNull();
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
    const dir = project({ name: "x", devDependencies: { vitest: "^4" } }, { installed: "vitest" });
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "test"], "vitest run")).toBeNull();
  });

  it("does not flag a directory with no manifest at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-deps-"));
    cleanup.push(dir);
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "test"])).toBeNull();
  });

  it("resolves a declared dependency from an ancestor node_modules, as Node does", () => {
    // A workspace package legitimately has no node_modules of its own.
    const root = mkdtempSync(join(tmpdir(), "polish-ws-"));
    cleanup.push(root);
    mkdirSync(join(root, "node_modules", "vitest"), { recursive: true });
    const pkg = join(root, "packages", "leaf");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "leaf", devDependencies: { vitest: "^4" } }));
    expect(untrustedForMissingDependencies(pkg, ["pnpm", "run", "test"], "vitest run")).toBeNull();
  });

  it("treats a Plug'n'Play marker as available, since PnP has no node_modules at all", () => {
    const dir = project({ name: "x", devDependencies: { vitest: "^4" } });
    writeFileSync(join(dir, ".pnp.cjs"), "// pnp");
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "test"], "vitest run")).toBeNull();
  });

  it("does not accept a node_modules that lacks the declared package", () => {
    const dir = project({ name: "x", devDependencies: { vitest: "^4" } }, { installed: "something-else" });
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "test"], "vitest run")).toBe(MISSING_DEPENDENCIES_REASON);
  });

  it("names an install command only for package managers it knows how to drive", () => {
    expect(installCommandFor("pnpm")).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(installCommandFor("npm")).toEqual(["npm", "ci"]);
    expect(installCommandFor("yarn")).toEqual(["yarn", "install", "--immutable"]);
    expect(installCommandFor(null)).toBeNull();
    expect(installCommandFor("cargo")).toBeNull();
  });

  it("treats an unreadable manifest as declaring nothing rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-deps-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(untrustedForMissingDependencies(dir, ["node", "--test"])).toBeNull();
    expect(untrustedForMissingDependencies(dir, ["pnpm", "run", "test"], "vitest run")).toBe(MISSING_DEPENDENCIES_REASON);
  });
});
