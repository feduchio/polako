import type { CorpusEntry, MissionAcceptanceCorpus, RuntimeEvidence } from "../domain/acceptance.js";
import type { DiscoveredRuntimeTemplate, RuntimeScenario, RuntimeValidator } from "./types.js";

export type RuntimeValidationLevel = "smoke" | "affected" | "full";

/** Map a phase-oriented level onto discovered templates. Smoke = first scenario; full = all. */
export function selectScenariosForLevel(
  templates: readonly DiscoveredRuntimeTemplate[],
  level: RuntimeValidationLevel,
): DiscoveredRuntimeTemplate[] {
  if (templates.length === 0) return [];
  if (level === "full") return [...templates];
  const first = templates[0];
  return first === undefined ? [] : [first];
}

export function templatesFromCorpus(corpus: MissionAcceptanceCorpus | readonly CorpusEntry[]): DiscoveredRuntimeTemplate[] {
  const entries: readonly CorpusEntry[] = Array.isArray(corpus) ? corpus : (corpus as MissionAcceptanceCorpus).entries;
  const out: DiscoveredRuntimeTemplate[] = [];
  for (const entry of entries) {
    if (entry.kind !== "runtime_scenario") continue;
    const script = typeof entry.metadata["script"] === "string" ? entry.metadata["script"] : null;
    const scenarioId = typeof entry.metadata["scenarioId"] === "string" ? entry.metadata["scenarioId"] : entry.id;
    if (script === null) continue;
    out.push({
      id: scenarioId,
      kind: "node_script",
      relativeScript: script,
      sideEffectPolicy: "safe",
    });
  }
  return out;
}

/** Parse `project.discovered` payload templates without trusting untyped event JSON. */
export function templatesFromDiscoveredPayload(payload: unknown): DiscoveredRuntimeTemplate[] {
  if (payload === null || typeof payload !== "object") return [];
  const raw = (payload as { runtimeTemplates?: unknown }).runtimeTemplates;
  if (!Array.isArray(raw)) return [];
  const out: DiscoveredRuntimeTemplate[] = [];
  for (const item of raw) {
    const template = asDiscoveredTemplate(item);
    if (template !== null) out.push(template);
  }
  return out;
}

/**
 * Production INTEGRATING template order: checkout discovery, else run-start
 * `project.discovered.runtimeTemplates`, else corpus. Corpus may supplement a
 * non-empty primary set but must not replace it.
 */
export function resolveProductionRuntimeTemplates(input: {
  checkoutTemplates: readonly DiscoveredRuntimeTemplate[];
  discoveredTemplates: readonly DiscoveredRuntimeTemplate[];
  corpusTemplates?: readonly DiscoveredRuntimeTemplate[];
}): DiscoveredRuntimeTemplate[] {
  const primary = input.checkoutTemplates.length > 0 ? input.checkoutTemplates : input.discoveredTemplates;
  const corpus = input.corpusTemplates ?? [];
  if (primary.length === 0) return [...corpus];
  return supplementTemplates(primary, corpus);
}

function asDiscoveredTemplate(item: unknown): DiscoveredRuntimeTemplate | null {
  if (item === null || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const templateId = rec["id"];
  const relativeScript = rec["relativeScript"];
  const sideEffectPolicy = rec["sideEffectPolicy"];
  if (typeof templateId !== "string" || templateId.length === 0) return null;
  if (rec["kind"] !== "node_script") return null;
  if (typeof relativeScript !== "string" || relativeScript.length === 0) return null;
  if (sideEffectPolicy !== "safe" && sideEffectPolicy !== "explicit") return null;
  return {
    id: templateId,
    kind: "node_script",
    relativeScript,
    sideEffectPolicy,
  };
}

function supplementTemplates(
  primary: readonly DiscoveredRuntimeTemplate[],
  extra: readonly DiscoveredRuntimeTemplate[],
): DiscoveredRuntimeTemplate[] {
  const seen = new Set(primary.map((template) => template.relativeScript));
  const out = [...primary];
  for (const template of extra) {
    if (seen.has(template.relativeScript)) continue;
    seen.add(template.relativeScript);
    out.push(template);
  }
  return out;
}

export function bindNodeScenario(input: {
  template: DiscoveredRuntimeTemplate;
  projectPath: string;
  runId: string;
  checkpointHash: string;
}): RuntimeScenario {
  return {
    id: input.template.id,
    runId: input.runId,
    checkpointHash: input.checkpointHash,
    kind: "node_script",
    fixtureRoot: input.projectPath,
    script: input.template.relativeScript,
    sideEffectPolicy: input.template.sideEffectPolicy,
  };
}

/** Re-execute corpus (or discovered) node scenarios against an exact checkpoint. */
export async function rerunRuntimeScenarios(input: {
  templates: readonly DiscoveredRuntimeTemplate[];
  projectPath: string;
  runId: string;
  checkpointHash: string;
  validator: RuntimeValidator;
  level?: RuntimeValidationLevel;
  signal?: AbortSignal;
}): Promise<RuntimeEvidence[]> {
  const selected = selectScenariosForLevel(input.templates, input.level ?? "full");
  const evidences: RuntimeEvidence[] = [];
  for (const template of selected) {
    const scenario = bindNodeScenario({
      template,
      projectPath: input.projectPath,
      runId: input.runId,
      checkpointHash: input.checkpointHash,
    });
    evidences.push(await input.validator.validate(scenario, input.signal));
  }
  return evidences;
}
