#!/usr/bin/env node
/**
 * Flip `if (` conditions added since a git ref and see whether the tests related to each file
 * kill them. The host checkout is never modified; mutants run in a /tmp copy that is removed at
 * the end.
 *
 *   node scripts/mutate-touched.mjs [base-ref] [--limit N|all] [--only path,path…]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const limitFlag = process.argv.indexOf("--limit");
const limitValue = limitFlag === -1 ? "8" : process.argv[limitFlag + 1];
const limit = limitValue === "all" ? Number.POSITIVE_INFINITY : Number(limitValue);
const onlyFlag = process.argv.indexOf("--only");
const only = onlyFlag === -1 ? null : (process.argv[onlyFlag + 1] ?? "").split(",").filter((path) => path !== "");
const valueFlags = new Set(["--limit", "--only"]);
const args = process.argv.slice(2).filter((arg, index, all) => !valueFlags.has(arg) && !valueFlags.has(all[index - 1] ?? ""));
const base = args[0] ?? "HEAD~1";

const diff = execFileSync("git", ["diff", "-U0", `${base}..HEAD`, "--", "src"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});

/** Every added line with a simple `if (...)`, at its line number in the file as of HEAD. */
const touched = [];
let file = "";
let nextLine = 0;
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ ")) {
    file = line.startsWith("+++ b/") ? line.slice(6) : "";
    continue;
  }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (hunk !== null) {
    nextLine = Number(hunk[1]);
    continue;
  }
  if (!line.startsWith("+")) continue;
  const lineNumber = nextLine;
  nextLine += 1;
  // src/e2e is the scenario harness only tests import: flipping its guards changes how a broken
  // test fails, not what the product does.
  if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.startsWith("src/e2e/")) continue;
  if (only !== null && !only.includes(file)) continue;
  const match = line.slice(1).match(/if\s*\(([^()]*)\)/);
  if (match === null) continue;
  touched.push({ file, line: lineNumber, condition: match[1], from: match[0] });
}

const sample = touched.slice(0, limit);
if (sample.length === 0) {
  console.log(`no simple if-conditions in ${base}..HEAD`);
  process.exit(0);
}

const copy = join(tmpdir(), `polish-mutate-${process.pid}`);
const removeCopy = () => rmSync(copy, { recursive: true, force: true });
process.on("SIGINT", () => {
  removeCopy();
  process.exit(130);
});
removeCopy();
mkdirSync(copy, { recursive: true });

let survived = 0;
let skipped = 0;
try {
  execFileSync("rsync", ["-a", "--exclude", "node_modules", "--exclude", "dist", "--exclude", ".git", `${root}/`, `${copy}/`]);
  execFileSync("ln", ["-sfn", join(root, "node_modules"), join(copy, "node_modules")]);
  for (const [index, item] of sample.entries()) {
    const where = `${item.file}:${String(item.line)}`;
    const path = join(copy, item.file);
    const original = readFileSync(path, "utf8");
    const lines = original.split("\n");
    const target = lines[item.line - 1];
    if (target === undefined || !target.includes(item.from)) {
      skipped += 1;
      console.log(`M${index} SKIP ${where} :: ${item.condition} (line does not hold the condition)`);
      continue;
    }
    for (const replacement of ["if (false)", "if (true)"]) {
      const mutated = [...lines];
      mutated[item.line - 1] = target.replace(item.from, replacement);
      writeFileSync(path, mutated.join("\n"));
      const code = runRelated(copy, item.file);
      const verdict = code === 0 ? "SURVIVE" : "KILL";
      if (verdict === "SURVIVE") survived += 1;
      console.log(`M${index} ${verdict} ${replacement} ${where} :: ${item.condition}`);
      writeFileSync(path, original);
    }
  }
} finally {
  removeCopy();
}
console.log(`${sample.length} of ${touched.length} conditions (${skipped} skipped), ${survived} surviving flips`);

/** Tests that import the file, directly or not; a condition no test reaches survives here. */
function runRelated(cwd, file) {
  try {
    execFileSync("pnpm", ["exec", "vitest", "related", file, "--run", "--bail=1", "--maxWorkers=50%", "--passWithNoTests"], { cwd, stdio: "ignore" });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}
