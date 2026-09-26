export function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=", 2);
    if (key === undefined || key === "") continue;
    out[key] = value ?? true;
  }
  return out;
}
