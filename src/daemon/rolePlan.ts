import type { ModelInfo } from "../broker/types.js";
import { inferFamily } from "../broker/diversity.js";
import type { PolishConfig } from "../domain/config.js";
import { createProviderFromConfig } from "../providers/factory.js";
import { LmStudioProvider } from "../providers/lmstudio.js";
import { parseModelRefString } from "./configLoad.js";

export type RoleName = keyof PolishConfig["roles"];

/**
 * Which stages of a card run call a model, and through which role. Everything not listed here
 * calls none: interpretation and planning of a card run, the gates, the finding-evidence worker
 * (it re-runs reproductions), the convergence check.
 */
export const ROLE_STAGES: Readonly<Record<RoleName, string>> = {
  implementer: "EXECUTING: the worker of every candidate (and its fallbacks); investigation workers",
  reviewers: "REVIEWING: one reviewer per axis; VALIDATING: the seeded-defect canary; CONVERGENCE_CHECK: review ensemble alternatives",
  verifier: "COMPARING: pairwise scoring of passing candidates (only when a card has two or more); the optional advisor",
  planner: "PLANNING: only when a worker asks to split a card (a card run itself has no planner call)",
  scope_guardian: "PLANNING: only on a split request",
  judge: "PLANNING: only on a split request; (the finding debate picks its own three families)",
  progress: "EXECUTING: the progress tracker, which needs two models of different families, else it is off",
};

export const ROLE_ORDER: readonly RoleName[] = ["implementer", "reviewers", "verifier", "planner", "scope_guardian", "judge", "progress"];

export type PinStatus = "ok" | "not installed" | "unchecked";

export interface ResolvedPin {
  ref: string;
  status: PinStatus;
  family: string;
  /** Short reason: what is wrong, or what was found. */
  detail: string;
}

export interface RoleResolution {
  role: RoleName;
  stage: string;
  pinned: boolean;
  /** The model the role starts with (first pin that is usable), or null when none can be. */
  first: string | null;
  chain: ResolvedPin[];
  /** For `reviewers`: how each pinned reviewer would review the implementer's work. */
  independence?: { ref: string; mode: "lineage" | "same-model-isolated" }[];
  note: string;
}

/** installed models by provider id; a provider that is absent from the map was not checked. */
export type InstalledModels = ReadonlyMap<string, readonly ModelInfo[]>;

/** The installed LLMs of every enabled lmstudio provider, from `lms ls --json` alone (no server request). */
export async function loadInstalledModels(config: PolishConfig): Promise<Map<string, ModelInfo[]>> {
  const out = new Map<string, ModelInfo[]>();
  for (const entry of config.providers) {
    if (!entry.enabled || entry.kind !== "lmstudio") continue;
    const provider = createProviderFromConfig(entry, "");
    if (provider instanceof LmStudioProvider) out.set(entry.id, await provider.installedModels());
  }
  return out;
}

function pinStatus(value: string, installed: InstalledModels): ResolvedPin {
  const ref = parseModelRefString(value);
  const models = installed.get(ref.provider);
  if (models === undefined) {
    return { ref: value, status: "unchecked", family: inferFamily(ref.model), detail: "provider not checked offline" };
  }
  if (models.length === 0) {
    return { ref: value, status: "unchecked", family: inferFamily(ref.model), detail: "lms ls listed no models (is the lms CLI installed?); not verified" };
  }
  const found = models.find((model) => model.ref.model === ref.model);
  if (found === undefined) {
    const keys = models.map((model) => model.ref.model);
    return { ref: value, status: "not installed", family: inferFamily(ref.model), detail: `not in lms ls (or excluded by models/excludeModels); installed: ${keys.join(", ") || "none"}` };
  }
  const caps = found.capabilities;
  return { ref: value, status: "ok", family: caps.family, detail: `${caps.family}, tools=${String(caps.supportsTools)}, ctx=${String(caps.contextWindow)}` };
}

/**
 * What each role resolves to under this config, without calling any model server. A pinned role
 * is its chain; an unpinned role is the router's choice and is described, not predicted.
 */
export function resolveRolePlan(config: PolishConfig, installed: InstalledModels): RoleResolution[] {
  const resolutions = ROLE_ORDER.map((role): RoleResolution => {
    const values = config.roles[role] ?? [];
    const chain = values.map((value) => pinStatus(value, installed));
    const first = chain.find((pin) => pin.status !== "not installed")?.ref ?? null;
    const everyone = [...installed.values()].flat().map((model) => model.ref.model);
    return {
      role,
      stage: ROLE_STAGES[role],
      pinned: values.length > 0,
      first,
      chain,
      note: role === "progress" && !config.agent.progressEnabled
        ? "off: agent.progressEnabled = false (two scoring models would swap the resident model inside a worker's loop)"
        : values.length > 0
        ? first === null ? "NO PINNED MODEL IS USABLE: the role will fail" : ""
        : `not pinned: the router chooses among ${String(everyone.length)} installed model(s)${everyone.length > 0 ? ` (${everyone.join(", ")})` : ""}`,
    };
  });
  const implementer = resolutions.find((item) => item.role === "implementer");
  const reviewers = resolutions.find((item) => item.role === "reviewers");
  const author = implementer?.chain.find((pin) => pin.status !== "not installed");
  if (reviewers !== undefined && author !== undefined) {
    reviewers.independence = reviewers.chain
      .filter((pin) => pin.status !== "not installed")
      .map((pin) => ({ ref: pin.ref, mode: pin.family === author.family ? "same-model-isolated" as const : "lineage" as const }));
  }
  return resolutions;
}

/** Text for `polako run --dry-run`. */
export function renderRolePlan(plan: readonly RoleResolution[]): string {
  const lines: string[] = ["Roles:"];
  for (const item of plan) {
    lines.push(`  ${item.role.padEnd(14)} ${item.first ?? "-"}${item.pinned ? "" : "  (router)"}`);
    lines.push(`    stage: ${item.stage}`);
    item.chain.forEach((pin, index) => lines.push(`    ${index === 0 ? "pin " : "then"} ${pin.ref}  [${pin.status}] ${pin.detail}`));
    for (const entry of item.independence ?? []) lines.push(`    review of ${entry.ref}: ${entry.mode}`);
    if (item.note !== "") lines.push(`    ${item.note}`);
  }
  return `${lines.join("\n")}\n`;
}
