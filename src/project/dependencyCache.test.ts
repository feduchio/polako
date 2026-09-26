import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessResult } from "../sandbox/process.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import { ensureProjectDependencies } from "./checkRunner.js";
import { dependencyCacheKey } from "./dependencyCache.js";
import type { ProjectProfile } from "./profile.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A checkout whose `npm ci` writes node_modules/left-pad, counting installs. */
function checkout(lockfile = '{"lockfileVersion":3}'): { handle: SandboxHandle; installs: () => number } {
  const path = tmp("polish-dep-checkout-");
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "node --test" }, dependencies: { "left-pad": "1.3.0" } }));
  writeFileSync(join(path, "package-lock.json"), lockfile);
  let installs = 0;
  const run = (argv: readonly string[]): Promise<ProcessResult> => {
    installs += 1;
    mkdirSync(join(path, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(path, "node_modules", "left-pad", "package.json"), '{"name":"left-pad"}');
    writeFileSync(join(path, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    return Promise.resolve({
      argv: [...argv], cwd: path, exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false, aborted: false, durationMs: 1, startedAt: 0,
    });
  };
  return { handle: { path, run, git: {} } as unknown as SandboxHandle, installs: () => installs };
}

const profile = {
  packageManager: "npm",
  checks: [{ name: "test", kind: "test", command: ["npm", "run", "test"], mandatory: true, timeoutMs: 1 }],
} as unknown as ProjectProfile;

describe("dependency cache", () => {
  it("installs once per lockfile and clones the tree into later checkouts, which can change it without touching the cache", async () => {
    const cacheDir = tmp("polish-dep-cache-");
    const first = checkout();
    const installed = await ensureProjectDependencies(first.handle, profile, { enabled: true, timeoutMs: 1_000, cacheDir });
    expect(installed).toMatchObject({ attempted: true, ready: true });
    expect(first.installs()).toBe(1);

    const second = checkout();
    const restored = await ensureProjectDependencies(second.handle, profile, { enabled: true, timeoutMs: 1_000, cacheDir });
    expect(restored).toMatchObject({ attempted: false, ready: true, detail: expect.stringMatching(/^dependencies restored from cache /) });
    expect(second.installs()).toBe(0);
    expect(readFileSync(join(second.handle.path, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports = 1;\n");

    writeFileSync(join(second.handle.path, "node_modules", "left-pad", "index.js"), "module.exports = 2;\n");
    const key = dependencyCacheKey(second.handle.path, "npm") ?? "";
    expect(readFileSync(join(cacheDir, key, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports = 1;\n");

    const otherLock = checkout('{"lockfileVersion":3,"packages":{}}');
    await ensureProjectDependencies(otherLock.handle, profile, { enabled: true, timeoutMs: 1_000, cacheDir });
    expect(otherLock.installs()).toBe(1);
  });

  it("does nothing without a cache directory or a lockfile", async () => {
    const plain = checkout();
    await ensureProjectDependencies(plain.handle, profile, { enabled: true, timeoutMs: 1_000 });
    expect(plain.installs()).toBe(1);
    rmSync(join(plain.handle.path, "package-lock.json"));
    expect(dependencyCacheKey(plain.handle.path, "npm")).toBeNull();
    expect(existsSync(join(plain.handle.path, "node_modules"))).toBe(true);
  });
});
