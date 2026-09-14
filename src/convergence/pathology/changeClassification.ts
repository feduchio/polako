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
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  const extension = /\.([^.]+)$/u.exec(basename)?.[1]?.toLowerCase() ?? "";
  if (!/^(?:[cm]?[jt]sx?|py|rb|go|rs|java|kts?|swift|cs|php|sh|bash)$/u.test(extension)) {
    return false;
  }
  const stem = basename.replace(/\.[^.]+$/u, "");
  const directories = segments.slice(0, -1);
  if (directories.some((segment) =>
    /^(?:__)?(?:fixtures?|helpers?|mocks?|snapshots?|support|common|data|utils?)(?:__)?$/iu.test(segment))) {
    return false;
  }
  const explicitName =
    /(?:^|[._-])(?:test|tests|spec)(?:[._-]|$)/iu.test(stem) ||
    /^(?:Test|Spec)[A-Z0-9_]/u.test(stem) ||
    /(?:Test|Tests|Spec)$/u.test(stem);
  if (explicitName) return true;
  if (/(?:^|[._-])(?:fixture|helper|mock|snapshot|support|common|data|util|utils|setup)(?:[._-]|$)/iu.test(stem)) {
    return false;
  }
  const parent = directories.at(-1)?.toLowerCase();
  // Direct children are runner-discoverable in conventional test roots. Nested support modules
  // need an explicit test/spec name; Cargo in particular compiles only direct tests/*.rs as cases.
  return parent === "test" || parent === "tests" || parent === "__tests__";
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
