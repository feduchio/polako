#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env, ...opts });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", env: process.env });
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

run("pnpm", ["link", "--global"]);

const whichPolish = capture("which", ["polish"]);
if (whichPolish.status !== 0) {
  const bin = capture("pnpm", ["bin", "-g"]);
  const globalBin = bin.stdout.trim();
  console.error("polish was linked but is not on PATH.");
  if (globalBin.length > 0) {
    console.error(`pnpm global bin directory: ${globalBin}`);
    console.error(`Add it to PATH, for example:`);
    console.error(`  export PATH="${globalBin}:$PATH"`);
  } else {
    console.error("Could not resolve `pnpm bin -g`. Enable pnpm's global bin directory, then retry `pnpm cli:link`.");
  }
  console.error("Do not add a machine-specific alias to ~/.zshrc as the install mechanism.");
  process.exit(1);
}

const whichDaemon = capture("which", ["polishd"]);
if (whichDaemon.status !== 0) {
  console.error("polish is on PATH but polishd is not. Retry `pnpm cli:link` after checking pnpm global bin setup.");
  process.exit(1);
}

console.log(`linked polish  → ${whichPolish.stdout.trim()}`);
console.log(`linked polishd → ${whichDaemon.stdout.trim()}`);
console.log("From any directory: polish --help");
