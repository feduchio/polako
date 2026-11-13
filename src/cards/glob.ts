/**
 * td's file-scope glob, kept identical so a card means the same here as under `night/run.mjs`:
 * `*` matches within one path segment, `**` matches across segments, everything else is literal.
 * `?` matches one character inside a segment.
 */
export function globToRegExp(glob: string): RegExp {
  const normalized = normalizePath(glob);
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped
    .replace(/\*\*/g, "\uE000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\uE000/g, ".*");
  return new RegExp(`^${source}$`);
}

export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  const target = normalizePath(path);
  return globs.some((glob) => globToRegExp(glob).test(target));
}

/** Changed paths the card's `files:` does not allow, in the order given. */
export function scopeViolations(changed: readonly string[], allowed: readonly string[]): string[] {
  const rules = allowed.map(globToRegExp);
  return changed.filter((path) => !rules.some((rule) => rule.test(normalizePath(path))));
}

/** True when the text contains glob metacharacters. */
export function isGlobPattern(text: string): boolean {
  return /[*?[\]{}]/.test(text);
}
