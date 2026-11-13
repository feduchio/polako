import type { Fact } from "../domain/fact.js";
import { isGroundTruth } from "../domain/fact.js";
import type { Finding } from "../domain/finding.js";
import type { Mission, MissionInterpretation } from "../domain/mission.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import type { Task } from "../domain/task.js";
import type { ProtocolBundle } from "../protocols/types.js";
import type { ProjectProfile } from "../project/profile.js";
import type { IntelHit } from "../intel/types.js";

export interface MissionContext {
  missionId: string;
  projectPath: string;
  text: string;
  userConstraints: string[];
  userDecisions: string[];
  hash: string;
}

export interface TaskGraphNode {
  id: string;
  kind: string;
  state: string;
  title: string;
  blockedBy: string[];
}

export interface SupervisorView {
  runId: string;
  tasks: TaskGraphNode[];
  facts: string[];
  decisions: string[];
  checkpoints: { id: string; commitHash: string; evidenceDigest: string }[];
  unresolvedFindings: { id: string; status: string; claim: string; severity: string }[];
}

export interface FileFragment {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface FailedAttempt {
  attempt: number;
  summary: string;
  errorExcerpt?: string;
  detail?: string;
}

export interface WorkerContextPack {
  /** The assembled text, exactly as measured. Callers send this rather than re-rendering
   *  `sections`, so the cap binds on the bytes that actually leave. */
  text: string;
  sections: Record<string, string>;
  /** Ordered section keys currently included */
  included: string[];
  estimatedTokens: number;
  protocolHash: string | null;
}

export interface BuildSupervisorInput {
  runId: string;
  tasks: readonly Task[];
  facts: readonly Fact[];
  findings: readonly Finding[];
  checkpoints: readonly Checkpoint[];
  /** tag/file affinity for ranking facts */
  focusTags?: readonly string[];
  focusFiles?: readonly string[];
  factLimit?: number;
}

export interface BuildWorkerInput {
  task: Task;
  interpretation?: MissionInterpretation | null;
  protocol?: ProtocolBundle | null;
  /** Critical non-droppable engineering policy; empty/whitespace falls back to the built-in safe policy. */
  baseEngineeringPolicy?: string;
  profile?: ProjectProfile | null;
  facts: readonly Fact[];
  findings: readonly Finding[];
  fileFragments: readonly FileFragment[];
  failedAttempts: readonly FailedAttempt[];
  /** current attempt number driving progressive disclosure */
  attemptNumber: number;
  tools: readonly string[];
  /** optional explore hits for request_context */
  extraHits?: readonly IntelHit[];
  /** The head of an existing test file, for a task that writes tests. */
  testExample?: { path: string; head: string } | null;
  /** Project brief and per-model notes from the user (card runs); protected like the task itself. */
  guidance?: string;
  maxPackTokens: number;
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

export function formatFactForPrompt(fact: Fact): string {
  const tags = fact.tags.length > 0 ? ` tags=${fact.tags.join(",")}` : "";
  const files = fact.files.length > 0 ? ` files=${fact.files.join(",")}` : "";
  if (isGroundTruth(fact)) {
    return `[${fact.provenanceKind}] (${fact.kind})${tags}${files} ${fact.statement}`;
  }
  return `[hypothesis:${fact.provenanceKind}] (${fact.kind})${tags}${files} ${fact.statement}`;
}

export function buildMissionContext(mission: Mission): MissionContext {
  const ctx: MissionContext = {
    missionId: mission.id,
    projectPath: mission.projectPath,
    text: mission.text,
    userConstraints: Object.freeze([...mission.userConstraints]) as string[],
    userDecisions: Object.freeze([...mission.userDecisions]) as string[],
    hash: mission.hash,
  };
  return Object.freeze(ctx);
}

export function discloseFailedAttempts(
  attempts: readonly FailedAttempt[],
  attemptNumber: number,
): FailedAttempt[] {
  return attempts.map((a) => {
    if (attemptNumber <= 1) {
      return { attempt: a.attempt, summary: a.summary };
    }
    if (attemptNumber === 2) {
      return {
        attempt: a.attempt,
        summary: a.summary,
        ...(a.errorExcerpt !== undefined ? { errorExcerpt: a.errorExcerpt } : {}),
      };
    }
    return { ...a };
  });
}

export function rankFacts(
  facts: readonly Fact[],
  focusTags: readonly string[],
  focusFiles: readonly string[],
  limit: number,
): Fact[] {
  const tagSet = new Set(focusTags);
  const fileSet = new Set(focusFiles);
  const scored = facts
    .filter((f) => f.supersededBy === null)
    .map((f) => {
      let score = 0;
      for (const t of f.tags) if (tagSet.has(t)) score += 2;
      for (const file of f.files) if (fileSet.has(file)) score += 3;
      if (isGroundTruth(f)) score += 1;
      return { f, score };
    })
    .sort((a, b) => b.score - a.score || a.f.statement.localeCompare(b.f.statement));
  return scored.slice(0, limit).map((s) => s.f);
}
