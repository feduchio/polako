import type { CheckpointChangeClassification } from "../../domain/convergence.js";

export function classifyCheckpointPaths(
  inputPaths: readonly string[],
): { paths: string[]; classification: CheckpointChangeClassification } {
  const paths = [...new Set(inputPaths.map(normalizePath).filter((path) => path.length > 0))]
    .sort(compareText);
  if (paths.length === 0) return { paths, classification: "unknown" };
  let hasTest = false;
  for (const path of paths) {
    if (isNeutralPath(path)) continue;
    if (isTestPath(path)) {
      hasTest = true;
      continue;
    }
    return { paths, classification: "production" };
  }
  return { paths, classification: hasTest ? "test_only" : "metadata_only" };
}

export function isTestPath(path: string): boolean {
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  if (segments.some((segment) =>
    segment === "test" ||
    segment === "tests" ||
    segment === "__tests__" ||
    segment === "__fixtures__")) {
    return true;
  }
  const basename = segments.at(-1) ?? "";
  return basename.includes(".test.") || basename.includes(".spec.");
}

/**
 * Narrower than checkpoint classification: corpus admission needs source a test runner can
 * execute, not fixtures, snapshots, golden data, or arbitrary files merely stored under tests/.
 */
export function isRunnableTestPath(path: string): boolean {
  if (!isTestPath(path)) return false;
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  if (!/\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kts?|swift|cs|php|sh|bash)$/u.test(basename)) {
    return false;
  }
  const stem = basename.replace(/\.[^.]+$/u, "");
  if (/(?:^|[._-])(?:fixture|fixtures|helper|helpers|mock|mocks|snapshot|snapshots)(?:[._-]|$)/iu.test(stem)) {
    return false;
  }
  if (/(?:^|[._-])(?:test|tests|spec)(?:[._-]|$)/iu.test(stem)) return true;
  if (/(?:Test|Tests|Spec)$/u.test(stem)) return true;
  // Jest/Vitest discover source files under __tests__; Cargo discovers every direct tests/*.rs.
  if (segments.includes("__tests__")) return true;
  return basename.endsWith(".rs") && segments.includes("tests");
}

function isNeutralPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === "docs" || normalized.startsWith("docs/");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/u, "").replace(/\/+/gu, "/").trim();
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
