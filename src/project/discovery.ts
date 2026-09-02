import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hashJson, sha256File } from "../shared/hash.js";
import { defaultCheckCommands, FrameworkHintSchema, PackageManagerSchema, ProjectProfileSchema, type ProjectProfile } from "./profile.js";

const MANIFEST_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "vitest.config.ts",
  "vitest.config.mjs",
  "jest.config.js",
  "jest.config.ts",
  "tsconfig.json",
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc.cjs",
];

/** Read manifests from disk and build a deterministic project profile. */
export function discoverProject(projectPath: string, alias: string | null = null): ProjectProfile {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) throw new Error(`no package.json at ${projectPath}`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const pm = detectPackageManager(projectPath);
  const manifestHashes: Record<string, string> = {};
  for (const rel of MANIFEST_FILES) {
    const p = join(projectPath, rel);
    if (existsSync(p)) manifestHashes[rel] = sha256File(p);
  }
  const framework = detectFramework(projectPath, scripts);
  const profile = ProjectProfileSchema.parse({
    projectPath,
    alias,
    packageManager: pm,
    framework,
    checks: defaultCheckCommands(pm, scripts),
    manifestHashes,
    scriptsHash: hashJson(scripts),
    discoveredAt: Date.now(),
  });
  return profile;
}

export function profileCacheKey(profile: Pick<ProjectProfile, "projectPath" | "manifestHashes" | "scriptsHash">): string {
  return hashJson({ projectPath: profile.projectPath, manifestHashes: profile.manifestHashes, scriptsHash: profile.scriptsHash });
}

function detectPackageManager(projectPath: string): ProjectProfile["packageManager"] {
  if (existsSync(join(projectPath, "pnpm-lock.yaml"))) return PackageManagerSchema.parse("pnpm");
  if (existsSync(join(projectPath, "yarn.lock"))) return PackageManagerSchema.parse("yarn");
  if (existsSync(join(projectPath, "bun.lock")) || existsSync(join(projectPath, "bun.lockb"))) return PackageManagerSchema.parse("bun");
  if (existsSync(join(projectPath, "package-lock.json"))) return PackageManagerSchema.parse("npm");
  return null;
}

function detectFramework(projectPath: string, scripts: Record<string, string>): ProjectProfile["framework"] {
  const pkg = readFileSync(join(projectPath, "package.json"), "utf8");
  if (pkg.includes("vitest") || Object.values(scripts).some((s) => s.includes("vitest"))) return FrameworkHintSchema.parse("vitest");
  if (pkg.includes("jest") || existsSync(join(projectPath, "jest.config.js")) || existsSync(join(projectPath, "jest.config.ts"))) {
    return FrameworkHintSchema.parse("jest");
  }
  return FrameworkHintSchema.parse("unknown");
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