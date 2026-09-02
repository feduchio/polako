import { parse as parseYaml } from "yaml";
import { PolishError } from "../shared/errors.js";
import { ProtocolFrontmatterSchema, type ProtocolFrontmatter } from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function parseSkillMarkdown(raw: string): { meta: ProtocolFrontmatter; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new PolishError("INVALID_ARGUMENT", "SKILL.md must start with YAML frontmatter delimited by ---");
  }
  const yamlText = match[1];
  const body = match[2].replace(/^\r?\n/, "");
  if (body.trim().length === 0) {
    throw new PolishError("INVALID_ARGUMENT", "SKILL.md body must be non-empty");
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    throw new PolishError("INVALID_ARGUMENT", `invalid SKILL.md frontmatter YAML: ${String(err)}`);
  }
  const meta = ProtocolFrontmatterSchema.parse(parsed);
  return { meta, body };
}
