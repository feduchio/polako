/**
 * Every name that must differ between this fork (polako) and the original (polish) so both can be
 * installed and run side by side: binaries, home directory, environment variables and the git
 * namespaces created in the target repository. Keep them here; upstream code reads them from
 * `BRAND`, so a merge from upstream only ever conflicts on this file's call sites.
 *
 * File names INSIDE the home directory (`polish.db`, `polish.sock`, …) are unchanged on purpose:
 * the home directory already separates the two tools, and keeping them minimises the merge diff.
 */
export const BRAND = {
  /** CLI, daemon and MCP binary names (`package.json` `bin`, `scripts/cli-link.mjs`) */
  cli: "polako",
  daemon: "polakod",
  mcp: "polako-mcp",
  /** home directory under `$HOME` and the env vars that override it */
  homeDir: ".polako",
  homeEnv: "POLAKO_HOME",
  socketEnv: "POLAKO_SOCKET",
  /** config file names inside the home, in order of preference (`polish.toml` stays readable) */
  configFiles: ["polako.toml", "polish.toml"],
  /** git branch namespace (`<prefix>/<run>/…`) and ref namespace created in the target repo */
  branchPrefix: "polako",
  refPrefix: "refs/polako",
  /** author/committer name on commits the tool makes */
  gitIdentity: "polako",
  /** directories of either tool that no scan of a project should descend into */
  ignoredDirs: [".polish", ".polako"],
} as const;
