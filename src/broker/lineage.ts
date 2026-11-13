import { canonicalFamily } from "./diversity.js";

/** What identifies where a local model comes from; every field is optional (a listing may state none). */
export interface LineageSource {
  modelKey: string;
  architecture?: string | undefined;
  publisher?: string | undefined;
  displayName?: string | undefined;
  path?: string | undefined;
}

/**
 * Architecture names, by prefix, to the vendor family the cloud catalogue would also use, so a local
 * Gemma and a cloud Gemini are one family (`canonicalFamily` knows `gemma` → `google`).
 */
const ARCHITECTURE_LINEAGE: readonly [RegExp, string][] = [
  [/^qwen/, "qwen"],
  [/^gpt[-_]?oss/, "openai"],
  [/^gemma/, "google"],
  [/^granite/, "ibm"],
  [/^llama/, "meta"],
  [/^(?:mistral|mixtral|ministral|magistral|devstral|codestral)/, "mistralai"],
  [/^phi/, "microsoft"],
  [/^deepseek/, "deepseek"],
  [/^(?:glm|chatglm)/, "zhipu"],
  [/^(?:kimi|moonshot)/, "moonshotai"],
];

/**
 * Names that betray a lineage when the architecture is silent or unhelpful. Fine-tunes carry their
 * own brand (`ornith`, `swift`, `huihui`) next to or instead of the base model's name; they are
 * the same lineage as the model they were trained from.
 */
const NAME_LINEAGE: readonly [RegExp, string][] = [
  [/qwen|qwq|ornith|swift|huihui/, "qwen"],
  [/gpt[-_]?oss/, "openai"],
  [/gemma/, "google"],
  [/granite/, "ibm"],
  [/llama/, "meta"],
  [/mistral|mixtral|ministral|magistral|devstral|codestral/, "mistralai"],
  [/(?:^|[^a-z])phi[-_\d]/, "microsoft"],
  [/deepseek/, "deepseek"],
  [/glm/, "zhipu"],
  [/kimi/, "moonshotai"],
];

/**
 * Lineage of a local model: the family that trained its base weights, not the person who fine-tuned
 * it. Two fine-tunes of one base share their errors far more than two vendors' models do, so the
 * diversity rule must count them once. Architecture decides first (`qwen35moe` → `qwen`), then the
 * model's names, then the architecture itself for an unknown lineage (`granitehybrid`), and
 * `unknown` only when nothing is stated.
 */
export function localLineage(source: LineageSource): string {
  const architecture = (source.architecture ?? "").toLowerCase().replace(/[\s_]+/g, "");
  const archKey = (source.architecture ?? "").toLowerCase();
  for (const [pattern, lineage] of ARCHITECTURE_LINEAGE) {
    if (pattern.test(archKey) || pattern.test(architecture)) return lineage;
  }
  const names = [source.modelKey, source.displayName, source.path].filter((value): value is string => value !== undefined).join(" ").toLowerCase();
  for (const [pattern, lineage] of NAME_LINEAGE) {
    if (pattern.test(names)) return lineage;
  }
  if (architecture.length > 0) return canonicalFamily(archKey.replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, ""));
  return "unknown";
}
