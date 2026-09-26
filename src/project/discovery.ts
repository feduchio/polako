import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hashJson, sha256File } from "../shared/hash.js";
import { defaultCheckCommands, PackageManagerSchema, ProjectProfileSchema, type ProjectProfile, type TestRunner } from "./profile.js";

const MANIFEST_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "vitest.config.ts",
  "vitest.config.mjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "jest.config.js",
  "jest.config.ts",
  "tsconfig.json",
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc.cjs",
];

/** Hash check-defining manifests and the package.json scripts block from a checkout. */
export function inspectManifestHashes(projectPath: string): {
  manifestHashes: Record<string, string>;
  scriptsHash: string;
} {
  const manifestHashes: Record<string, string> = {};
  for (const rel of MANIFEST_FILES) {
    const p = join(projectPath, rel);
    if (existsSync(p)) manifestHashes[rel] = sha256File(p);
  }
  let scriptsHash = "";
  const pkgPath = join(projectPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      scriptsHash = hashJson(pkg.scripts ?? {});
    } catch {
      scriptsHash = "";
    }
  }
  return { manifestHashes, scriptsHash };
}

/** Read manifests from disk and build a deterministic project profile. */
export function discoverProject(projectPath: string, alias: string | null = null): ProjectProfile {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) throw new Error(`no package.json at ${projectPath}`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown> & {
    scripts?: Record<string, string>;
    packageManager?: unknown;
  };
  const scripts = pkg.scripts ?? {};
  const pm = detectPackageManager(projectPath, pkg);
  const { manifestHashes, scriptsHash } = inspectManifestHashes(projectPath);
  const { framework, testRunner } = detectTestRunner(projectPath, pkg, scripts);
  const profile = ProjectProfileSchema.parse({
    projectPath,
    alias,
    packageManager: pm,
    framework,
    testRunner,
    checks: defaultCheckCommands(pm, scripts),
    manifestHashes,
    scriptsHash,
    discoveredAt: Date.now(),
  });
  return profile;
}

export function profileCacheKey(profile: Pick<ProjectProfile, "projectPath" | "manifestHashes" | "scriptsHash">): string {
  return hashJson({ projectPath: profile.projectPath, manifestHashes: profile.manifestHashes, scriptsHash: profile.scriptsHash });
}

function detectPackageManager(
  projectPath: string,
  pkg: { packageManager?: unknown },
): ProjectProfile["packageManager"] {
  const fromField = parsePackageManagerField(pkg.packageManager);
  if (fromField !== null) return fromField;
  if (existsSync(join(projectPath, "pnpm-lock.yaml"))) return PackageManagerSchema.parse("pnpm");
  if (existsSync(join(projectPath, "yarn.lock"))) return PackageManagerSchema.parse("yarn");
  if (existsSync(join(projectPath, "bun.lock")) || existsSync(join(projectPath, "bun.lockb"))) return PackageManagerSchema.parse("bun");
  if (existsSync(join(projectPath, "package-lock.json"))) return PackageManagerSchema.parse("npm");
  return null;
}

function parsePackageManagerField(raw: unknown): ProjectProfile["packageManager"] {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const name = raw.split("@")[0]?.trim().toLowerCase();
  const parsed = PackageManagerSchema.safeParse(name);
  return parsed.success ? parsed.data : null;
}

type Framework = ProjectProfile["framework"];

interface Invocation {
  framework: Exclude<Framework, "unknown">;
  fileArgv: string[];
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const VITEST_CONFIGS = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs"];
const JEST_CONFIGS = ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs", "jest.config.json"];

/**
 * The runner the test script itself invokes decides; installed dependencies and config files only
 * decide when no script names a runner. A package name is never read as a runner.
 */
function detectTestRunner(projectPath: string, pkg: Record<string, unknown>, scripts: Record<string, string>): {
  framework: Framework;
  testRunner: TestRunner | null;
} {
  const testScript = scripts["test"] !== undefined ? "test" : scripts["vitest"] !== undefined ? "vitest" : null;
  const ordered = [...(testScript === null ? [] : [testScript]), ...Object.keys(scripts).filter((name) => name !== testScript)];
  for (const name of ordered) {
    const invocation = invocationIn(scripts[name] ?? "");
    if (invocation !== null) return { framework: invocation.framework, testRunner: { fileArgv: invocation.fileArgv, script: name } };
  }
  const deps = new Set(DEPENDENCY_FIELDS.flatMap((field) => Object.keys((pkg[field] as Record<string, unknown> | undefined) ?? {})));
  if (deps.has("vitest") || VITEST_CONFIGS.some((file) => existsSync(join(projectPath, file)))) {
    return { framework: "vitest", testRunner: { fileArgv: ["node_modules/.bin/vitest", "run"], script: null } };
  }
  if (deps.has("jest") || pkg["jest"] !== undefined || JEST_CONFIGS.some((file) => existsSync(join(projectPath, file)))) {
    return { framework: "jest", testRunner: { fileArgv: ["node_modules/.bin/jest"], script: null } };
  }
  if (Object.values(scripts).some((script) => script.includes("node:test"))) {
    return { framework: "node-test", testRunner: { fileArgv: ["node", "--test"], script: null } };
  }
  return { framework: "unknown", testRunner: null };
}

/** The first shell segment of `script` that runs a known test runner, with its single-file argv. */
function invocationIn(script: string): Invocation | null {
  for (const segment of script.split(/&&|\|\||;|\|/)) {
    const words = shellWords(segment).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const start = words.findIndex((word) => word === "node" || word === "vitest" || word === "jest");
    if (start === -1) continue;
    const program = words[start];
    if (program === "vitest") return { framework: "vitest", fileArgv: ["node_modules/.bin/vitest", "run"] };
    if (program === "jest") return { framework: "jest", fileArgv: ["node_modules/.bin/jest"] };
    const test = words.indexOf("--test", start + 1);
    if (test !== -1 && onlyOptionsBetween(words, start + 1, test)) {
      return { framework: "node-test", fileArgv: words.slice(start, test + 1) };
    }
  }
  return null;
}

/** Node options before `--test` are flags and their values; a bare path there means node runs a script, not the runner. */
function onlyOptionsBetween(words: readonly string[], from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) {
    const word = words[i] ?? "";
    if (word.startsWith("-")) continue;
    const previous = words[i - 1] ?? "";
    if (!(i > from && previous.startsWith("--") && !previous.includes("="))) return false;
  }
  return true;
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  for (const match of segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3] ?? "");
  return words;
}

/** In-memory profile cache invalidated when manifest hashes change. */
export class ProfileCache {
  private readonly entries = new Map<string, ProjectProfile>();

  get(projectPath: string): ProjectProfile | null {
    const live = discoverProject(projectPath, this.entries.get(projectPath)?.alias ?? null);
    const key = profileCacheKey(live);
    const cached = this.entries.get(projectPath);
    if (cached && profileCacheKey(cached) === key) return cached;
    this.entries.set(projectPath, live);
    return live;
  }

  invalidate(projectPath: string): void {
    this.entries.delete(projectPath);
  }
}

export { sha256File } from "../shared/hash.js";