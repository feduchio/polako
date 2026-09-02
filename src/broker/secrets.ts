import { existsSync, readFileSync, statSync } from "node:fs";
import { PolishError } from "../shared/errors.js";

/**
 * Provider credentials live in `~/.polish/secrets.env` (KEY=VALUE lines), never in config
 * or in any worker environment. Loaded once by the daemon.
 */
export class SecretStore {
  private readonly values = new Map<string, string>();
  readonly warnings: string[] = [];

  static fromFile(path: string, fallbackEnv: Readonly<Record<string, string | undefined>> = {}): SecretStore {
    const store = new SecretStore();
    if (existsSync(path)) {
      const mode = statSync(path).mode & 0o777;
      if (mode & 0o077) store.warnings.push(`${path} is readable by others (mode ${mode.toString(8)}); chmod 600 recommended`);
      for (const [k, v] of parseDotenv(readFileSync(path, "utf8"))) store.values.set(k, v);
    }
    for (const [k, v] of Object.entries(fallbackEnv)) {
      if (v !== undefined && !store.values.has(k) && /(_API_KEY|_TOKEN)$/.test(k)) store.values.set(k, v);
    }
    return store;
  }

  static fromValues(values: Record<string, string>): SecretStore {
    const store = new SecretStore();
    for (const [k, v] of Object.entries(values)) store.values.set(k, v);
    return store;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  get(name: string): string {
    const v = this.values.get(name);
    if (v === undefined) throw new PolishError("CONFIG_ERROR", `secret ${name} is not configured`, { name });
    return v;
  }

  /** Names only — safe to log. */
  names(): string[] {
    return [...this.values.keys()].sort();
  }

  /** Replace any secret value occurring in `text` with a placeholder (for logs/artifacts). */
  redact(text: string): string {
    let out = text;
    for (const [name, value] of this.values) {
      if (value.length < 8) continue;
      out = out.split(value).join(`<redacted:${name}>`);
    }
    return out;
  }
}

export function parseDotenv(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out.push([m[1] ?? "", value]);
  }
  return out;
}
