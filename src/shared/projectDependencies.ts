import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Only these two decide availability. `optionalDependencies` may legitimately be absent after a
 * successful install, and `peerDependencies` are the consumer's to provide, so requiring either
 * would refuse projects that are correctly installed.
 */
const REQUIRED_FIELDS = ["dependencies", "devDependencies"] as const;

/** Command shapes whose result depends on installed packages even when the manifest declares none. */
const NEEDS_INSTALLED_PACKAGES = /node_modules|(?<![a-z])(vitest|jest|mocha|ava|tsx)(?![a-z])/i;

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
  for (const field of REQUIRED_FIELDS) {
    const value = record[field];
    if (typeof value === "object" && value !== null) names.push(...Object.keys(value));
  }
  return names;
}

/** Whether `relative` exists in `cwd` or in any ancestor, which is how Node resolution looks. */
function resolvesUpward(cwd: string, relative: string): boolean {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, relative))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * A package is installed when its own manifest is there, not when a directory bearing its name is.
 * An empty `node_modules/<name>` is what a half-finished or interrupted install leaves behind, and
 * Node cannot resolve it — trusting the directory would readmit the defect through the back door.
 */
function packageInstalled(cwd: string, name: string): boolean {
  return resolvesUpward(cwd, join("node_modules", name, "package.json"));
}

/** Plug'n'Play resolves with no `node_modules` anywhere, so its marker settles availability. */
function usesPnp(cwd: string): boolean {
  return PNP_MARKERS.some((marker) => resolvesUpward(cwd, marker));
}

/**
 * Whether **every** declared package is reachable from `cwd`.
 *
 * Every, not any: a partial install — one package present, another missing — is exactly the state
 * in which a check fails for an environmental reason while looking like a project failure. That is
 * the defect this module exists to prevent, and an `any` test lets it straight back in.
 *
 * Reachability walks upward because Node resolution does: a package inside a workspace
 * legitimately has no `node_modules` of its own while the root has one.
 */
function dependenciesAvailable(cwd: string, names: readonly string[]): boolean {
  if (names.length === 0) return true;
  if (usesPnp(cwd)) return true;
  return names.every((name) => packageInstalled(cwd, name));
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
  // A manifest that declares nothing can still run a command that needs packages. Look for the
  // runner itself rather than for any `node_modules`: the presence of that directory says nothing
  // about whether the binary this command needs is inside it.
  if (usesPnp(cwd)) return null;
  const runner = NEEDS_INSTALLED_PACKAGES.exec(`${argv.join(" ")}\n${scriptText ?? ""}`);
  if (runner === null) return null;
  const name = runner[1];
  if (name !== undefined && resolvesUpward(cwd, join("node_modules", ".bin", name))) return null;
  return MISSING_DEPENDENCIES_REASON;
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
