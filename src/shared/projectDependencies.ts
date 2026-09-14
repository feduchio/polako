import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** Command shapes whose result depends on installed packages even when the manifest declares none. */
const NEEDS_INSTALLED_PACKAGES = /node_modules|(?<![a-z])(vitest|jest|mocha|ava)(?![a-z])/i;

/** Yarn Plug'n'Play resolves without a `node_modules` directory at all. */
const PNP_MARKERS = [".pnp.cjs", ".pnp.js", ".pnp.mjs"] as const;

export const MISSING_DEPENDENCIES_REASON = "missing installed dependencies";

function declaredDependencies(manifestPath: string): string[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    // An unreadable manifest is not evidence that packages are needed; the command-shape test in
    // `untrustedForMissingDependencies` still applies.
    return [];
  }
  if (typeof manifest !== "object" || manifest === null) return [];
  const record = manifest as Record<string, unknown>;
  const names: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const value = record[field];
    if (typeof value === "object" && value !== null) names.push(...Object.keys(value));
  }
  return names;
}

/**
 * Whether the declared packages are reachable from `cwd`.
 *
 * Walks upward rather than testing one directory, because Node resolution does: a package inside a
 * workspace legitimately has no `node_modules` of its own while the root has one. A Plug'n'Play
 * marker counts as available, since PnP projects resolve with no `node_modules` anywhere.
 */
function dependenciesAvailable(cwd: string, names: readonly string[]): boolean {
  if (names.length === 0) return true;
  let dir = cwd;
  for (;;) {
    if (PNP_MARKERS.some((marker) => existsSync(join(dir, marker)))) return true;
    if (names.some((name) => existsSync(join(dir, "node_modules", name)))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Whether a command's result would say something about the environment rather than about the
 * project, because the project's packages are not reachable from where the command ran.
 *
 * One definition, used by the check runner and by the finding-reproduction path. Two of them is how
 * finding 54 survived: reproduction already refused to draw a conclusion from this state while
 * baselining drew one and stored it as the project's own check status.
 *
 * Decided from the filesystem and never from output text. `sh: oxlint: command not found` is a
 * message, not a contract, and a locale or a tool change moves it.
 *
 * Residual false positive: a project that declares dependencies it does not need for this
 * particular command, and fails legitimately, is classified as untrusted too. That is the
 * fail-closed direction — declining to state something we cannot support is better than stating
 * something false, which is the defect this exists to prevent.
 */
export function untrustedForMissingDependencies(
  cwd: string,
  argv: readonly string[],
  scriptText?: string | null,
): string | null {
  const manifestPath = join(cwd, "package.json");
  if (!existsSync(manifestPath)) return null;
  const declared = declaredDependencies(manifestPath);
  if (!dependenciesAvailable(cwd, declared)) return MISSING_DEPENDENCIES_REASON;
  if (declared.length > 0) return null;
  // A manifest that declares nothing can still run a command that needs packages.
  if (existsSync(join(cwd, "node_modules"))) return null;
  if (NEEDS_INSTALLED_PACKAGES.test(`${argv.join(" ")}\n${scriptText ?? ""}`)) return MISSING_DEPENDENCIES_REASON;
  return null;
}

/**
 * The command that installs a project's dependencies, or `null` for a package manager we do not
 * know how to drive. One definition, shared by the runner that issues it and the allowlist that
 * admits it, so a command can never be issued that the policy does not name.
 */
export function installCommandFor(packageManager: string | null): string[] | null {
  if (packageManager === null) return null;
  switch (packageManager) {
    case "pnpm":
      return ["pnpm", "install", "--frozen-lockfile"];
    case "npm":
      return ["npm", "ci"];
    case "yarn":
      return ["yarn", "install", "--immutable"];
    case "bun":
      return ["bun", "install", "--frozen-lockfile"];
    default:
      return null;
  }
}
