import { z } from "zod";
import { CheckDefinitionSchema, type CheckDefinition } from "../domain/checks.js";
import { Sha256Schema } from "../domain/common.js";

export const PackageManagerSchema = z.enum(["pnpm", "npm", "yarn", "bun"]);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

export const FrameworkHintSchema = z.enum(["vitest", "jest", "node-test", "unknown"]);
export type FrameworkHint = z.infer<typeof FrameworkHintSchema>;

/** How the project's test runner runs one test file: `fileArgv` with the file's path appended. */
export const TestRunnerSchema = z.object({
  fileArgv: z.array(z.string().min(1)).min(1),
  /** The package script the argv was derived from; null when it comes from the framework alone. */
  script: z.string().min(1).nullable(),
});
export type TestRunner = z.infer<typeof TestRunnerSchema>;

export const ProfileScoutFindingSchema = z.object({
  kind: z.enum(["architecture", "vocabulary", "entrypoint"]),
  statement: z.string().min(1),
  provenanceKind: z.enum(["llm_inferred", "verified"]),
  provenanceRefs: z.array(z.string()).min(1),
  evidenceRefs: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
  files: z.array(z.string()),
});
export type ProfileScoutFinding = z.infer<typeof ProfileScoutFindingSchema>;

/** Deterministic view of a project discovered from manifests on disk. */
export const ProjectProfileSchema = z.object({
  projectPath: z.string().min(1),
  alias: z.string().min(1).nullable(),
  packageManager: PackageManagerSchema.nullable(),
  framework: FrameworkHintSchema,
  /** Absent on profiles recorded before it existed; null when no single-file form is known. */
  testRunner: TestRunnerSchema.nullable().optional(),
  checks: z.array(CheckDefinitionSchema).min(1),
  /** relative path -> sha256 of files that define checks (package.json, vitest.config.*, ...) */
  manifestHashes: z.record(z.string(), Sha256Schema),
  /** sha256 of the scripts block used for checks */
  scriptsHash: Sha256Schema,
  discoveredAt: z.number().int().nonnegative(),
  /** Scout hypotheses. They remain llm_inferred until independently verified. */
  scoutFindings: z.array(ProfileScoutFindingSchema).optional(),
});
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

export interface RegistryEntry {
  projectPath: string;
  alias: string | null;
  registeredAt: number;
}

/** In-memory registry of known project roots (daemon persists via config later). */
export class ProjectRegistry {
  private readonly byPath = new Map<string, RegistryEntry>();
  private readonly byAlias = new Map<string, string>();

  register(projectPath: string, alias: string | null = null): RegistryEntry {
    const entry: RegistryEntry = { projectPath, alias, registeredAt: Date.now() };
    this.byPath.set(projectPath, entry);
    if (alias) this.byAlias.set(alias, projectPath);
    return entry;
  }

  get(projectPathOrAlias: string): RegistryEntry | null {
    return this.byPath.get(projectPathOrAlias) ?? this.byPath.get(this.byAlias.get(projectPathOrAlias) ?? "") ?? null;
  }

  list(): RegistryEntry[] {
    return [...this.byPath.values()].sort((a, b) => a.projectPath.localeCompare(b.projectPath));
  }
}

export function defaultCheckCommands(pm: PackageManager | null, scripts: Record<string, string>): CheckDefinition[] {
  const run = (name: string, script: string, kind: CheckDefinition["kind"], mandatory: boolean): CheckDefinition | null => {
    if (!script) return null;
    const argv = pm ? [pm, "run", name] : ["npm", "run", name];
    return { name, kind, command: argv, mandatory, timeoutMs: kind === "test" ? 600_000 : 300_000 };
  };
  const checks: (CheckDefinition | null)[] = [
    run("test", scripts["test"] ?? scripts["vitest"] ?? "", "test", true),
    run("lint", scripts["lint"] ?? scripts["eslint"] ?? "", "lint", true),
    run("typecheck", scripts["typecheck"] ?? scripts["check"] ?? "", "typecheck", true),
    run("build", scripts["build"] ?? "", "build", false),
  ];
  const out = checks.filter((c): c is CheckDefinition => c !== null);
  if (out.length === 0) {
    out.push({ name: "test", kind: "test", command: pm ? [pm, "test"] : ["npm", "test"], mandatory: true, timeoutMs: 600_000 });
  }
  return out;
}
