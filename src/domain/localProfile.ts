/**
 * The local-model defaults profile (docs/LOCAL.md §d). It is applied to the raw TOML before the
 * schema parses it, as defaults only: anything the user wrote wins, so the schema's own defaults,
 * and every cloud run, stay exactly upstream's.
 */

export type ConfigProfile = "auto" | "local" | "cloud";

/** Sized for one resident model on a 48 GB Mac: one task at a time, few candidates, short packs. */
export const LOCAL_PROFILE_DEFAULTS: Readonly<Record<string, unknown>> = {
  execution: { maxParallelTasks: 1 },
  candidates: { trivial: 1, normal: 1, complex: 2 },
  review: {
    // Each reviewer of another family costs a model swap (~10-20 s) plus prompt processing; the
    // third axis is the one most likely to be the same model again.
    reviewersPerRound: 2,
    // Only one lineage may be installed; then the author's lineage reviews in isolation.
    sameModelFallback: true,
    // The local reviewers all missed tests that could not fail; the audit makes that a blocking finding.
    falsifiabilityAudit: true,
    // A reasoning model spends part of max_tokens on thought; upstream's 1500 truncates it.
    // Ornith thinks before it answers; a review it was cut off in (at 4096) counted as a failed reviewer.
    maxOutputTokens: 12288,
  },
  // The progress tracker scores each worker turn with two models of different families; with one
  // resident model that would swap it in and out in the middle of a worker's loop.
  // 80 turns: a 6-criterion card needed more than the default 32 (read, edit, fix a bad anchor, re-run the gate)
  // and a worker that runs out of turns loses all its work.
  agent: { progressEnabled: false, maxTurns: 80 },
  // Ornith spends part of any budget on thought: at the default 256 its strict-review probe was cut off
  // (`length`), recorded probe_failed, and the model dropped out of the reviewer pool (1024 passes).
  discovery: { probeMaxTokens: 2048 },
  // Prompt processing is the slow part (110-500 tok/s): keep packs well under the 64k load.
  contextBudget: { maxPackTokens: 24_000 },
  // Two clean rounds, not three: with two reviewers (one deterministic at temperature 0) a third identical
  // round costs ~10 minutes and says nothing new; DONE still needs passing deterministic gates.
  convergence: { requiredCleanRounds: 2 },
  // One call at a time on the one resident model; tests and builds must not fight it for memory.
  lanes: { "llm.default": 1, "local.shell": 2, "local.test": 1, "local.build": 1, supervisor: 1, verifier: 1 },
  // A failed call costs minutes, not a rate-limit window: one attempt per council model, short backoff.
  council: { maxAttemptsPerModel: 1, baseBackoffMs: 500, maxBackoffMs: 2_000 },
};

/** Defaults for each `kind = "lmstudio"` provider entry. */
export const LOCAL_PROVIDER_DEFAULTS: Readonly<Record<string, unknown>> = {
  // The tool owns which model is loaded; it batches calls by model to minimise swaps.
  manageResidency: true,
  // Minutes to the first token on a long prompt, then ~25 tok/s: the request is not streamed.
  timeoutMs: 30 * 60_000,
  contextLength: 65_536,
};

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Providers the user left enabled; a provider table without `enabled = false` counts. */
function enabledProviders(raw: Raw): Raw[] {
  const providers = raw["providers"];
  return Array.isArray(providers) ? providers.filter(isRecord).filter((entry) => entry["enabled"] !== false) : [];
}

/** True when the profile applies: `profile = "local"`, or `auto` with every enabled provider an `lmstudio` one. */
export function isLocalProfile(raw: Raw): boolean {
  const profile = raw["profile"];
  if (profile === "local") return true;
  if (profile === "cloud") return false;
  const providers = enabledProviders(raw);
  return providers.length > 0 && providers.every((entry) => entry["kind"] === "lmstudio");
}

/** `defaults` underneath `user`: objects merge recursively, any other value the user set wins. */
function mergeUnder(defaults: Raw, user: Raw): Raw {
  const out: Raw = { ...defaults };
  for (const [key, value] of Object.entries(user)) {
    const base = out[key];
    out[key] = isRecord(base) && isRecord(value) ? mergeUnder(base, value) : value;
  }
  return out;
}

/** The raw config with the local defaults underneath it, or the raw config itself outside the profile. */
export function applyLocalProfile(raw: Raw): Raw {
  if (!isLocalProfile(raw)) return raw;
  const merged = mergeUnder(LOCAL_PROFILE_DEFAULTS, raw);
  if (Array.isArray(raw["providers"])) {
    merged["providers"] = raw["providers"].map((entry: unknown) =>
      isRecord(entry) && entry["kind"] === "lmstudio" ? mergeUnder(LOCAL_PROVIDER_DEFAULTS as Raw, entry) : entry,
    );
  }
  return merged;
}
