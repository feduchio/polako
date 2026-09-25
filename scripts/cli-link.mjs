#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localBin = join(homedir(), ".local", "bin");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args, env = process.env) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", env });
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
  console.error(`polish requires Node >= 24; this process is ${process.version}.`);
  console.error("Use Node 24 (nvm use 24 / fnm use 24 / n / volta), then retry `pnpm cli:link`.");
  process.exit(1);
}

run("pnpm", ["build"]);

const polishBin = join(root, "dist/cli/index.js");
const polishdBin = join(root, "dist/daemon/main.js");
const mcpBin = join(root, "dist/mcp/index.js");
if (!existsSync(polishBin) || !existsSync(polishdBin) || !existsSync(mcpBin)) {
  console.error("build did not produce dist/cli/index.js, dist/daemon/main.js, and dist/mcp/index.js");
  process.exit(1);
}
chmodSync(polishBin, 0o755);
chmodSync(polishdBin, 0o755);
chmodSync(mcpBin, 0o755);

const pnpmBinDir = capture("pnpm", ["bin", "-g"]).stdout.trim();
const pathDirs = [];
if (pnpmBinDir.length > 0) {
  mkdirSync(pnpmBinDir, { recursive: true });
  pathDirs.push(pnpmBinDir);
  const env = { ...process.env, PATH: `${pnpmBinDir}:${process.env["PATH"] ?? ""}` };
  const added = spawnSync("pnpm", ["add", "--global", root], { cwd: root, stdio: "inherit", env });
  if (added.status !== 0) {
    console.error("pnpm add --global failed; continuing with ~/.local/bin shims.");
  }
} else {
  console.error("`pnpm bin -g` is empty; installing shims into ~/.local/bin instead of a stale global link.");
}

mkdirSync(localBin, { recursive: true });
pathDirs.unshift(localBin);
for (const [name, target] of [
  ["polish", polishBin],
  ["polishd", polishdBin],
  ["polish-mcp", mcpBin],
]) {
  const dest = join(localBin, name);
  try {
    unlinkSync(dest);
  } catch {
    // missing is fine
  }
  symlinkSync(target, dest);
}

const env = { ...process.env, PATH: `${pathDirs.join(":")}:${process.env["PATH"] ?? ""}` };
const expectedPolish = realpathSync(polishBin);
const expectedDaemon = realpathSync(polishdBin);
const expectedMcp = realpathSync(mcpBin);

function resolved(command) {
  const which = capture("which", [command], env);
  if (which.status !== 0) return null;
  const path = which.stdout.trim();
  try {
    return { path, real: realpathSync(path) };
  } catch {
    return { path, real: path };
  }
}

const polish = resolved("polish");
const daemon = resolved("polishd");
if (polish === null || daemon === null) {
  console.error("polish/polishd are not on PATH after linking.");
  console.error(`Add ${localBin} to PATH, for example:`);
  console.error(`  export PATH="${localBin}:$PATH"`);
  process.exit(1);
}
if (polish.real !== expectedPolish) {
  console.error("polish on PATH is not this repository's current build (stale link).");
  console.error(`  which polish → ${polish.path} (${polish.real})`);
  console.error(`  expected     → ${expectedPolish}`);
  console.error(`Put ${localBin} ahead of other polish installs on PATH and retry.`);
  process.exit(1);
}
if (daemon.real !== expectedDaemon) {
  console.error("polishd on PATH is not this repository's current build (stale link).");
  console.error(`  which polishd → ${daemon.path} (${daemon.real})`);
  console.error(`  expected      → ${expectedDaemon}`);
  process.exit(1);
}

const mcp = resolved("polish-mcp");
if (mcp === null || mcp.real !== expectedMcp) {
  console.error("polish-mcp on PATH is not this repository's current build.");
  console.error(`  expected → ${expectedMcp}`);
  process.exit(1);
}
console.log(`linked polish     → ${polish.path}`);
console.log(`linked polishd    → ${daemon.path}`);
console.log(`linked polish-mcp → ${mcp.path}`);
console.log("Everyday use from any directory: polish run ...");
console.log("pnpm cli:link is an install/update step, not part of ordinary product usage.");
