import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { applyLocalProfile } from "../domain/localProfile.js";
import { defaultConfig, PolishConfigSchema, type PolishConfig } from "../domain/config.js";
import { BRAND } from "../shared/brand.js";
import { PolishError } from "../shared/errors.js";
import { errorToString } from "../shared/errors.js";

/** Parse a user model reference such as `gemini:models/gemini-3.8-flash` or `scripted:sup`. */
export function parseModelRefString(value: string): { provider: string; model: string } {
  const colon = value.indexOf(":");
  if (colon <= 0 || colon >= value.length - 1) {
    throw new PolishError("CONFIG_ERROR", `invalid model reference ${value}`);
  }
  return { provider: value.slice(0, colon), model: value.slice(colon + 1) };
}

/**
 * Load `polish.toml` from the polish home directory.
 * Missing file → defaults; invalid TOML or schema → CONFIG_ERROR (fail closed).
 */
export function loadPolishConfig(home: string): PolishConfig {
  const path = BRAND.configFiles.map((name) => join(home, name)).find((candidate) => existsSync(candidate));
  if (path === undefined) return defaultConfig();
  let config: PolishConfig;
  try {
    const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    config = PolishConfigSchema.parse({ ...applyLocalProfile(raw), home });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new PolishError("CONFIG_ERROR", `invalid ${basename(path)}`, {
        path,
        issues: error.issues.map((issue) => issue.message),
      });
    }
    throw new PolishError("CONFIG_ERROR", `failed to parse ${basename(path)}`, {
      path,
      cause: errorToString(error),
    });
  }
  assertRolePins(config);
  return config;
}

/** Every role pin must name a provider that is configured and enabled; checked when the config loads. */
export function assertRolePins(config: PolishConfig): void {
  const enabled = new Set(config.providers.filter((entry) => entry.enabled).map((entry) => entry.id));
  const problems: string[] = [];
  for (const [role, values] of Object.entries(config.roles)) {
    for (const value of values ?? []) {
      const ref = parseModelRefString(value);
      if (!enabled.has(ref.provider)) {
        problems.push(`roles.${role}: ${value} names provider "${ref.provider}", which is not an enabled [[providers]] id (${[...enabled].join(", ") || "none"})`);
      }
    }
  }
  if (problems.length > 0) throw new PolishError("CONFIG_ERROR", `invalid [roles]:\n- ${problems.join("\n- ")}`, { problems });
}
