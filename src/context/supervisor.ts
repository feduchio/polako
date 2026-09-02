import type { Checkpoint } from "../domain/checkpoint.js";
import {
  formatFactForPrompt,
  rankFacts,
  type BuildSupervisorInput,
  type SupervisorView,
  type TaskGraphNode,
} from "./types.js";

export function buildSupervisorView(input: BuildSupervisorInput): SupervisorView {
  const tasks: TaskGraphNode[] = input.tasks.map((t) => ({
    id: t.id,
    kind: t.kind,
    state: t.state,
    title: t.title,
    blockedBy: [...t.dependsOn],
  }));

  const facts = rankFacts(
    input.facts,
    input.focusTags ?? [],
    input.focusFiles ?? [],
    input.factLimit ?? 20,
  ).map(formatFactForPrompt);

  const decisions = input.facts
    .filter((f) => f.kind === "decision" && f.supersededBy === null)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, 20)
    .map(formatFactForPrompt);

  const checkpoints = [...input.checkpoints]
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 10)
    .map((c: Checkpoint) => ({
      id: c.id,
      commitHash: c.commitHash,
      evidenceDigest: digestEvidence(c),
    }));

  const unresolvedFindings = input.findings
    .filter((f) => f.status === "VALID" || f.status === "VALIDATING" || f.status === "UNCERTAIN")
    .map((f) => ({
      id: f.id,
      status: f.status,
      claim: f.claim,
      severity: f.severity,
    }));

  return {
    runId: input.runId,
    tasks,
    facts,
    decisions,
    checkpoints,
    unresolvedFindings,
  };
}

function digestEvidence(c: Checkpoint): string {
  const open = Object.entries(c.evidence.openValidatedFindings)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}:${n}`)
    .join(",");
  return [
    `tests=${c.evidence.testsPassed}/${c.evidence.testsTotal}`,
    `failed=${c.evidence.testsFailed}`,
    `diff=${c.evidence.diffLinesFromBaseline}`,
    open ? `open=${open}` : "open=0",
    c.commitHash.slice(0, 12),
  ].join("|");
}
