import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../shared/hash.js";

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"];
const COMPLETE = ".polish-complete";

/**
 * Installed dependencies keyed by what determines them: the lockfile's bytes, the package manager,
 * Node's version and the platform. Every checkout of the same lockfile gets the same tree, so the
 * install runs once per key instead of once per checkout; on macOS the tree is materialized by an
 * APFS clone (`cp -c`), which shares blocks until either side writes (after oh-my-pi's `pi-iso`).
 * Null when the checkout has no lockfile: without one the tree is not a function of the checkout.
 */
export function dependencyCacheKey(checkoutPath: string, packageManager: string | null): string | null {
  const lockfile = LOCKFILES.find((name) => existsSync(join(checkoutPath, name)));
  if (lockfile === undefined || packageManager === null) return null;
  const bytes = readFileSync(join(checkoutPath, lockfile));
  return sha256Hex(JSON.stringify([packageManager, lockfile, sha256Hex(bytes.toString("base64")), process.version, process.platform, process.arch])).slice(0, 32);
}

/** Copy the cached `node_modules` for `key` into the checkout; false when there is none. */
export function restoreDependencies(cacheDir: string, key: string, checkoutPath: string): boolean {
  const entry = join(cacheDir, key);
  if (!existsSync(join(entry, COMPLETE)) || existsSync(join(checkoutPath, "node_modules"))) return false;
  try {
    copyTree(join(entry, "node_modules"), join(checkoutPath, "node_modules"));
    return true;
  } catch {
    rmSync(join(checkoutPath, "node_modules"), { recursive: true, force: true });
    return false;
  }
}

/** Keep the checkout's freshly installed `node_modules` under `key`; a failure to cache is not an error. */
export function storeDependencies(cacheDir: string, key: string, checkoutPath: string): void {
  const entry = join(cacheDir, key);
  if (existsSync(join(entry, COMPLETE)) || !existsSync(join(checkoutPath, "node_modules"))) return;
  const staging = join(cacheDir, `.${key}.${String(process.pid)}.${String(Date.now())}`);
  try {
    mkdirSync(staging, { recursive: true });
    copyTree(join(checkoutPath, "node_modules"), join(staging, "node_modules"));
    writeFileSync(join(staging, COMPLETE), new Date().toISOString());
    renameSync(staging, entry);
  } catch {
    rmSync(staging, { recursive: true, force: true });
  }
}

function copyTree(from: string, to: string): void {
  // -c asks macOS cp for clonefile(2); elsewhere a plain recursive copy that keeps symlinks.
  execFileSync("cp", process.platform === "darwin" ? ["-c", "-R", from, to] : ["-R", "-P", from, to], { stdio: "ignore" });
}
