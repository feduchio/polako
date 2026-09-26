import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { testFileOperandDenial } from "../sandbox/allowlist.js";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".polish"]);
const MAX_DEPTH = 6;
const MAX_ENTRIES = 5_000;
const HEAD_LINES = 25;
const HEAD_CHARS = 1_600;
const FRAMEWORK_MARK: Record<string, RegExp> = {
  "node-test": /["']node:test["']/,
  vitest: /["']vitest["']/,
  jest: /\b(?:describe|test|it)\s*\(/,
};

/**
 * The head of one existing test file, preferring one written for the project's own runner. A
 * worker told only `framework=node-test` wrote Jest-style tests on SAT twice; one real file shows
 * the imports and assertion style the runner accepts.
 */
export function findTestExample(projectPath: string, framework: string): { path: string; head: string } | null {
  const tests: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || seen > MAX_ENTRIES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      seen += 1;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const rel = relative(projectPath, join(dir, entry.name)).split("\\").join("/");
        if (testFileOperandDenial(rel) === null) tests.push(rel);
      }
    }
  };
  walk(projectPath, 0);
  const mark = FRAMEWORK_MARK[framework];
  const heads = tests.map((path) => ({ path, text: safeRead(join(projectPath, path)) })).filter((item) => item.text !== "");
  const chosen = heads.find((item) => mark?.test(item.text) === true) ?? heads[0];
  if (chosen === undefined) return null;
  return { path: chosen.path, head: chosen.text.split("\n").slice(0, HEAD_LINES).join("\n").slice(0, HEAD_CHARS) };
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
