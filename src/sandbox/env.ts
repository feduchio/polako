/**
 * Build a child-process environment from an allowlist, with deny patterns applied on top.
 * Defense in depth only (see docs/THREAT_MODEL.md): secrets must not be in the parent env
 * of workers in the first place; this makes accidental leakage through `process.env` unlikely.
 */
export interface EnvPolicy {
  allowlist: readonly string[];
  denyPatterns: readonly string[];
  /** variables always set for workers (deterministic tooling behaviour) */
  fixed?: Readonly<Record<string, string>>;
}

export const DEFAULT_FIXED_ENV: Readonly<Record<string, string>> = {
  CI: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  TERM: "dumb",
  NODE_ENV: "test",
  GIT_TERMINAL_PROMPT: "0",
};

export function scrubEnv(
  source: Readonly<Record<string, string | undefined>>,
  policy: EnvPolicy,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const deny = policy.denyPatterns.map((p) => new RegExp(p, "i"));
  const out: Record<string, string> = {};
  const denied = (name: string): boolean => deny.some((re) => re.test(name));

  for (const name of policy.allowlist) {
    const value = source[name];
    if (value === undefined || denied(name)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(policy.fixed ?? DEFAULT_FIXED_ENV)) out[name] = value;
  for (const [name, value] of Object.entries(extra)) {
    if (denied(name)) continue;
    out[name] = value;
  }
  return out;
}

/** Names in `source` that look like secrets — for `polish doctor` warnings. */
export function suspiciousEnvNames(source: Readonly<Record<string, string | undefined>>, denyPatterns: readonly string[]): string[] {
  const deny = denyPatterns.map((p) => new RegExp(p, "i"));
  return Object.keys(source)
    .filter((n) => deny.some((re) => re.test(n)))
    .sort();
}
