import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** Command shapes whose result depends on installed packages even when the manifest declares none. */
const NEEDS_INSTALLED_PACKAGES = /node_modules|(?<![a-z])(vitest|jest|mocha|ava)(?![a-z])/i;

/** Whether the manifest asks for packages at all. A project that declares none needs no install. */
function declaresDependencies(manifestPath: string): boolean {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    // An unreadable manifest is not evidence that packages are needed; the command-shape test below
    // still applies.
    return false;
  }
  if (typeof manifest !== "object" || manifest === null) return false;
  const record = manifest as Record<string, unknown>;
  return DEPENDENCY_FIELDS.some((field) => {
    const value = record[field];
    return typeof value === "object" && value !== null && Object.keys(value).length > 0;
  });
}

export const MISSING_DEPENDENCIES_REASON = "missing installed dependencies";

/**
 * Whether a command's result would say something about the environment rather than about the
 * project, because the project's packages are not installed where the command ran.
 *
 * One definition, used by both the check runner and the finding-reproduction path. Two of them is
 * how finding 54 survived: reproduction already refused to draw a conclusion from this state while
 * baselining drew one and stored it as the project's check status.
 *
 * Decided from the filesystem and never from output text. `sh: oxlint: command not found` is a
 * message, not a contract, and a locale or a tool change moves it.
 *
 * Residual false positive: a project that declares dependencies, does not need them for this
 * particular command, and fails legitimately is classified as untrusted too. That is the
 * fail-closed direction — declining to state something we cannot support is better than stating
 * something false, which is the defect this exists to prevent.
 *
 * A project that declares no dependencies is not caught by that: `fixtures/resume-dup-fetch` runs
 * `node --test` and needs no install, which is why the declared-dependency test is here and an
 * "argv[0] is a package manager" test is not.
 */
export function untrustedForMissingDependencies(
  cwd: string,
  argv: readonly string[],
  scriptText?: string | null,
): string | null {
  if (existsSync(join(cwd, "node_modules"))) return null;
  const manifestPath = join(cwd, "package.json");
  if (!existsSync(manifestPath)) return null;
  if (declaresDependencies(manifestPath)) return MISSING_DEPENDENCIES_REASON;
  if (NEEDS_INSTALLED_PACKAGES.test(`${argv.join(" ")}\n${scriptText ?? ""}`)) return MISSING_DEPENDENCIES_REASON;
  return null;
}
