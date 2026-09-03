#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args, env = process.env) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", env });
}

run("pnpm", ["build"]);

const polishBin = join(root, "dist/cli/index.js");
const polishdBin = join(root, "dist/daemon/main.js");
if (!existsSync(polishBin) || !existsSync(polishdBin)) {
  console.error("build did not produce dist/cli/index.js and dist/daemon/main.js");
  process.exit(1);
}
chmodSync(polishBin, 0o755);
chmodSync(polishdBin, 0o755);

const binDir = capture("pnpm", ["bin", "-g"]).stdout.trim();
if (binDir.length === 0) {
  console.error("Could not resolve `pnpm bin -g`. Run `pnpm setup`, then retry `pnpm cli:link`.");
  process.exit(1);
}
mkdirSync(binDir, { recursive: true });
const env = { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` };

run("pnpm", ["add", "--global", root], env);

const localBin = join(homedir(), ".local", "bin");
if (existsSync(dirname(localBin))) {
  mkdirSync(localBin, { recursive: true });
  for (const [name, target] of [
    ["polish", polishBin],
    ["polishd", polishdBin],
  ]) {
    const dest = join(localBin, name);
    try {
      unlinkSync(dest);
    } catch {
      // missing is fine
    }
    symlinkSync(target, dest);
  }
}

const whichPolish = capture("which", ["polish"], env);
if (whichPolish.status !== 0) {
  console.error("polish was linked but is not on PATH.");
  console.error(`pnpm global bin directory: ${binDir}`);
  console.error(`Add it to PATH, for example:`);
  console.error(`  export PATH="${binDir}:$PATH"`);
  console.error("Do not add a machine-specific alias to ~/.zshrc as the install mechanism.");
  process.exit(1);
}

const whichDaemon = capture("which", ["polishd"], env);
if (whichDaemon.status !== 0) {
  console.error("polish is on PATH but polishd is not. Retry `pnpm cli:link` after checking pnpm global bin setup.");
  process.exit(1);
}

console.log(`linked polish  → ${whichPolish.stdout.trim()}`);
console.log(`linked polishd → ${whichDaemon.stdout.trim()}`);
console.log("From any directory: polish --help");
