import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { defaultConfig, PolishConfigSchema, type PolishConfig } from "../domain/config.js";
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
  const path = join(home, "polish.toml");
  if (!existsSync(path)) return defaultConfig();
  try {
    const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return PolishConfigSchema.parse({ ...raw, home });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new PolishError("CONFIG_ERROR", "invalid polish.toml", {
        path,
        issues: error.issues.map((issue) => issue.message),
      });
    }
    throw new PolishError("CONFIG_ERROR", "failed to parse polish.toml", {
      path,
      cause: errorToString(error),
    });
  }
}
