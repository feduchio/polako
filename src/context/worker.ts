import { isGroundTruth } from "../domain/fact.js";
import {
  discloseFailedAttempts,
  estimateTokens,
  formatFactForPrompt,
  type BuildWorkerInput,
  type WorkerContextPack,
} from "./types.js";

/** Section drop order for budget fitting (last dropped first). Never drops mission/task. */
const DROP_ORDER = [
  "extraHits",
  "failedAttempts",
  "findings",
  "fileFragments",
  "architectureNotes",
  "invariants",
  "tools",
  "protocol",
] as const;

/**
 * Build a worker context pack and fit it to `maxPackTokens`.
 * Mission + task/acceptance are always retained when present.
 */
export function buildWorkerContextPack(input: BuildWorkerInput): WorkerContextPack {
  const sections: Record<string, string> = {};

  sections["task"] = [
    `Task ${input.task.id} (${input.task.kind})`,
    input.task.title,
    input.task.description,
    "Acceptance:",
    ...input.task.acceptance.map((a) => `- ${a}`),
  ].join("\n");

  if (input.interpretation) {
    sections["mission"] = [
      `Goals: ${input.interpretation.goals.join("; ")}`,
      `Success: ${input.interpretation.definitionOfSuccess.join("; ")}`,
      `Non-goals: ${input.interpretation.nonGoals.join("; ") || "(none)"}`,
      `Constraints: ${input.interpretation.constraints.join("; ") || "(none)"}`,
    ].join("\n");
  }

  if (input.protocol) {
    sections["protocol"] = input.protocol.promptText;
  }

  if (input.profile) {
    const notes = [
      `packageManager=${input.profile.packageManager}`,
      `framework=${input.profile.framework}`,
      `checks=${input.profile.checks.map((c) => c.name).join(",")}`,
    ];
    sections["architectureNotes"] = notes.join("\n");
  }

  const invariants = input.facts.filter((f) => f.kind === "invariant" && isGroundTruth(f) && f.supersededBy === null);
  if (invariants.length > 0) {
    sections["invariants"] = invariants.map(formatFactForPrompt).join("\n");
  }

  const taskFiles = new Set(input.fileFragments.map((f) => f.path));
  const findings = input.findings.filter(
    (f) =>
      f.status === "VALID" &&
      f.evidence.some((e) => taskFiles.has(e.path) || input.task.description.includes(e.path)),
  );
  if (findings.length > 0) {
    sections["findings"] = findings.map((f) => `[${f.severity}] ${f.claim}`).join("\n");
  }

  if (input.fileFragments.length > 0) {
    sections["fileFragments"] = input.fileFragments
      .map((f) => `// ${f.path}:${f.startLine}-${f.endLine}\n${f.text}`)
      .join("\n\n");
  }

  const disclosed = discloseFailedAttempts(input.failedAttempts, input.attemptNumber);
  if (disclosed.length > 0) {
    sections["failedAttempts"] = disclosed
      .map((a) => {
        const parts = [`#${a.attempt} ${a.summary}`];
        if (a.errorExcerpt) parts.push(`error: ${a.errorExcerpt}`);
        if (a.detail) parts.push(a.detail);
        return parts.join("\n");
      })
      .join("\n\n");
  }

  if (input.tools.length > 0) {
    sections["tools"] = input.tools.join(", ");
  }

  if (input.extraHits && input.extraHits.length > 0) {
    sections["extraHits"] = input.extraHits.map((h) => `${h.path}:${h.line} ${h.text}`).join("\n");
  }

  return fitWorkerPack(sections, input.maxPackTokens, input.protocol?.hash ?? null);
}

export function fitWorkerPack(
  sections: Record<string, string>,
  maxPackTokens: number,
  protocolHash: string | null,
): WorkerContextPack {
  const included = Object.keys(sections);
  const pack = (): WorkerContextPack => {
    const text = included.map((k) => `## ${k}\n${sections[k] ?? ""}`).join("\n\n");
    return {
      sections: Object.fromEntries(included.map((k) => [k, sections[k] ?? ""])),
      included: [...included],
      estimatedTokens: estimateTokens(text),
      protocolHash,
    };
  };

  let result = pack();
  if (result.estimatedTokens <= maxPackTokens) return result;

  for (const key of DROP_ORDER) {
    const idx = included.indexOf(key);
    if (idx < 0) continue;
    included.splice(idx, 1);
    result = pack();
    if (result.estimatedTokens <= maxPackTokens) return result;
  }
  return result;
}
