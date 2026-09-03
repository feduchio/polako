#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = { ...process.env };
const binDir = spawnSync("pnpm", ["bin", "-g"], { encoding: "utf8", env }).stdout.trim();
if (binDir.length > 0) env.PATH = `${binDir}:${env.PATH ?? ""}`;

const result = spawnSync("pnpm", ["remove", "--global", "polish"], { stdio: "inherit", env });

const localBin = join(homedir(), ".local", "bin");
for (const name of ["polish", "polishd"]) {
  const dest = join(localBin, name);
  if (existsSync(dest)) {
    try {
      unlinkSync(dest);
    } catch {
      // leave in place if not writable
    }
  }
}

process.exit(result.status ?? 1);
