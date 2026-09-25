/**
 * One vendor may appear under several spellings, and a diversity rule that compares spellings
 * counts one vendor twice: Gemini's listing names `models/gemini-2.5-flash` (prefix `models`),
 * OpenRouter aliases a vendor's latest route as `~openai/...`, and Meta publishes as both `meta`
 * and `meta-llama`.
 */
const FAMILY_ALIASES: Record<string, string> = {
  "meta-llama": "meta",
  gemini: "google",
  gemma: "google",
  "bytedance-seed": "bytedance",
};

/** Vendor family from the model id prefix (`vendor/model` on OpenRouter) or well-known name stems. */
export function inferFamily(modelId: string): string {
  const id = modelId.replace(/^models\//i, "").replace(/^~/, "");
  const slash = id.indexOf("/");
  if (slash > 0) return canonicalFamily(id.slice(0, slash));
  const lower = id.toLowerCase();
  const stems: [RegExp, string][] = [
    [/^(gpt|o\d|chatgpt)/, "openai"],
    [/^claude/, "anthropic"],
    [/^gemini|^gemma/, "google"],
    [/^llama/, "meta"],
    [/^mixtral|^mistral|^magistral|^codestral/, "mistralai"],
    [/^deepseek/, "deepseek"],
    [/^qwen|^qwq/, "qwen"],
    [/^grok/, "x-ai"],
    [/^kimi|^moonshot/, "moonshotai"],
  ];
  for (const [re, fam] of stems) if (re.test(lower)) return fam;
  return canonicalFamily(lower.split(/[-_:.]/)[0] ?? lower);
}

export function canonicalFamily(family: string): string {
  const lower = family.toLowerCase().replace(/^~/, "");
  return FAMILY_ALIASES[lower] ?? lower;
}

/**
 * One item per family, in the given order, skipping families in `avoid`.
 *
 * A check made by a second model of the same family is the same check twice: the founding rule is
 * that no model's answer is trusted where a model of another family can check it. Callers that need
 * `n` independent checks count the result; they do not pad it with duplicates.
 */
export function distinctFamilies<T>(
  items: readonly T[],
  familyOf: (item: T) => string,
  avoid: ReadonlySet<string> = new Set(),
): T[] {
  const seen = new Set<string>(avoid);
  const out: T[] = [];
  for (const item of items) {
    const family = familyOf(item);
    if (seen.has(family)) continue;
    seen.add(family);
    out.push(item);
  }
  return out;
}

export function familyCount<T>(items: readonly T[], familyOf: (item: T) => string): number {
  return new Set(items.map(familyOf)).size;
}
