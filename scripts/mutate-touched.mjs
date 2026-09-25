#!/usr/bin/env node
/**
 * Flip `if (` conditions touched since a git ref and see whether tests kill them.
 * The host checkout is never modified; mutants run in /tmp.
 *
 *   node scripts/mutate-touched.mjs [base-ref] [--limit N]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--limit");
const limitFlag = process.argv.indexOf("--limit");
const limit = limitFlag === -1 ? 8 : Number(process.argv[limitFlag + 1]);
const base = args[0] ?? "HEAD~1";

const diff = execFileSync("git", ["diff", "-U0", `${base}..HEAD`, "--", "src"], {
  cwd: root,
  encoding: "utf8",
});

const touched = [];
let file = "";
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ b/")) file = line.slice(6);
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
  const body = line.slice(1).trim();
  const match = body.match(/if\s*\(([^()]*)\)/);
  if (match === null) continue;
  touched.push({ file, condition: match[1], snippet: body });
}

const sample = touched.slice(0, limit);
if (sample.length === 0) {
  console.log(`no simple if-conditions in ${base}..HEAD`);
  process.exit(0);
}

const copy = join(tmpdir(), `polish-mutate-${process.pid}`);
rmSync(copy, { recursive: true, force: true });
mkdirSync(copy, { recursive: true });
execFileSync("rsync", ["-a", "--exclude", "node_modules", "--exclude", "dist", "--exclude", ".git", `${root}/`, `${copy}/`]);
execFileSync("ln", ["-sfn", join(root, "node_modules"), join(copy, "node_modules")]);

let survived = 0;
for (const [index, item] of sample.entries()) {
  const path = join(copy, item.file);
  const original = readFileSync(path, "utf8");
  const from = `if (${item.condition})`;
  if (!original.includes(from)) {
    console.log(`M${index} SKIP ${item.file} :: ${from}`);
    continue;
  }
  const test = item.file.replace(/\.ts$/, ".test.ts");
  const target = exists(join(copy, test)) ? test : dirname(item.file);
  for (const replacement of [`if (false)`, `if (true)`]) {
    writeFileSync(path, original.replace(from, replacement));
    const code = run(copy, target);
    const verdict = code === 0 ? "SURVIVE" : "KILL";
    if (verdict === "SURVIVE") survived += 1;
    console.log(`M${index} ${verdict} ${replacement} ${item.file}`);
    writeFileSync(path, original);
  }
}
console.log(`${sample.length} of ${touched.length} conditions, ${survived} surviving flips`);

function exists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function run(cwd, target) {
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", target, "--maxWorkers=1"], { cwd, stdio: "ignore" });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}
