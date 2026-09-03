import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveredRuntimeTemplate, ProjectRuntimeDiscovery } from "./types.js";

const SCRIPT_NAMES = ["resume-check.mjs", "check.mjs", "scenario.mjs"];

/**
 * Classify a project's local runtime validation surface. Phase B only discovers safe
 * in-tree node scripts; unsafe/networked adapters are recorded as AVAILABLE_UNSAFE and
 * left unused under `auto`.
 */
export function discoverProjectRuntime(projectPath: string): ProjectRuntimeDiscovery {
  if (!existsSync(join(projectPath, "package.json"))) {
    return { capability: "NOT_APPLICABLE", reason: "no package.json", templates: [] };
  }
  const runtimeDir = join(projectPath, "runtime");
  if (!existsSync(runtimeDir) || !statSync(runtimeDir).isDirectory()) {
    return { capability: "NOT_APPLICABLE", reason: "no runtime/ directory", templates: [] };
  }
  const present = new Set(readdirSync(runtimeDir));
  const templates: DiscoveredRuntimeTemplate[] = [];
  for (const name of SCRIPT_NAMES) {
    if (!present.has(name)) continue;
    templates.push({
      id: `runtime/${name}`,
      kind: "node_script",
      relativeScript: `runtime/${name}`,
      sideEffectPolicy: "safe",
    });
  }
  if (templates.length === 0) {
    return { capability: "UNAVAILABLE", reason: "runtime/ exists but has no known scenario script", templates: [] };
  }
  return {
    capability: "AVAILABLE_SAFE",
    reason: `safe node scenarios: ${templates.map((t) => t.relativeScript).join(", ")}`,
    templates,
  };
}
