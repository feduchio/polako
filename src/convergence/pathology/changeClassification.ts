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
