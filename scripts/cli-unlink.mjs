#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = { ...process.env };
const binDir = spawnSync("pnpm", ["bin", "-g"], { encoding: "utf8", env }).stdout.trim();
if (binDir.length > 0) env.PATH = `${binDir}:${env.PATH ?? ""}`;

let status = 0;
if (binDir.length > 0) {
  const result = spawnSync("pnpm", ["remove", "--global", "polish"], { stdio: "inherit", env });
  status = result.status ?? 1;
}

const localBin = join(homedir(), ".local", "bin");
let removedLocal = false;
for (const name of ["polish", "polishd"]) {
  const dest = join(localBin, name);
  if (!existsSync(dest)) continue;
  try {
    if (lstatSync(dest).isSymbolicLink() || existsSync(dest)) unlinkSync(dest);
    removedLocal = true;
  } catch {
    // leave in place if not writable
  }
}

if (binDir.length === 0 && removedLocal) status = 0;
process.exit(status);
