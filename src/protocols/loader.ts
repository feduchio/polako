import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PolishError } from "../shared/errors.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import type { LoadedProtocol } from "./types.js";
import { readdirSync } from "node:fs";

/**
 * Loads agentskills.io-compatible protocols from a directory of `<name>/SKILL.md` trees.
 */
export class ProtocolRegistry {
  private readonly byName = new Map<string, LoadedProtocol>();

  private constructor(readonly rootDir: string) {}

  static load(rootDir: string): ProtocolRegistry {
    const abs = resolve(rootDir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new PolishError("NOT_FOUND", `protocols root not found: ${abs}`, { protocolsRoot: abs });
    }
    const registry = new ProtocolRegistry(abs);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(abs, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      try {
        const raw = readFileSync(skillPath, "utf8");
        const { meta, body } = parseSkillMarkdown(raw);
        if (meta.name !== entry.name) {
          throw new PolishError(
            "INVARIANT_VIOLATION",
            `protocol name ${JSON.stringify(meta.name)} must match directory ${JSON.stringify(entry.name)}`,
          );
        }
        if (registry.byName.has(meta.name)) {
          throw new PolishError("INVARIANT_VIOLATION", `duplicate protocol ${meta.name}`);
        }
        registry.byName.set(meta.name, { meta, body, dir: dirname(skillPath) });
      } catch (error) {
        throw protocolEntryError(skillPath, error);
      }
    }
    return registry;
  }

  list(): LoadedProtocol[] {
    return [...this.byName.values()].sort((a, b) => a.meta.name.localeCompare(b.meta.name));
  }

  get(name: string): LoadedProtocol {
    const p = this.byName.get(name);
    if (!p) throw new PolishError("NOT_FOUND", `protocol not found: ${name}`);
    return p;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * Read a progressive-disclosure resource listed in the protocol frontmatter.
   * Rejects path escape outside the protocol directory and unlisted paths.
   */
  readResource(protocolName: string, relativePath: string): string {
    const protocol = this.get(protocolName);
    const normalized = normalize(relativePath).replaceAll("\\", "/");
    if (
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.startsWith("/") ||
      normalized.includes("\0")
    ) {
      throw new PolishError("INVALID_ARGUMENT", `illegal resource path: ${relativePath}`);
    }
    const listed =
      protocol.meta.resources.includes(normalized) || protocol.meta.resources.includes(relativePath);
    if (!listed) {
      throw new PolishError("NOT_FOUND", `resource not listed for ${protocolName}: ${relativePath}`);
    }
    const abs = resolve(protocol.dir, normalized);
    const rootReal = realpathSync(protocol.dir);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new PolishError("NOT_FOUND", `resource file missing: ${protocolName}/${normalized}`);
    }
    const fileReal = realpathSync(abs);
    const rel = relative(rootReal, fileReal);
    if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || rel === "") {
      throw new PolishError("INVALID_ARGUMENT", `resource escapes protocol directory: ${relativePath}`);
    }
    return readFileSync(fileReal, "utf8");
  }
}

/**
 * The failing `SKILL.md` is a local here and nowhere else, so the path is attached at the throw
 * rather than re-derived by a caller: a second copy of the name/folder rule can disagree with this
 * one and then name the wrong directory. `ProtocolFrontmatterSchema.parse` throws a `ZodError`, so
 * this is also the point where a non-`PolishError` becomes one.
 */
function protocolEntryError(skillPath: string, error: unknown): PolishError {
  if (error instanceof PolishError) {
    return new PolishError(error.code, error.message, { ...error.details, skillPath }, { cause: error });
  }
  return new PolishError(
    "INVALID_ARGUMENT",
    error instanceof Error ? error.message : String(error),
    { skillPath },
    { cause: error },
  );
}

/** Default on-disk protocols root (`<repo>/protocols`). */
export function defaultProtocolsRoot(from = import.meta.url): string {
  const here = dirname(fileURLToPath(from));
  return resolve(here, "..", "..", "protocols");
}
