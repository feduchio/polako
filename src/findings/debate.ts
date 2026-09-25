import type { CorpusEntryKind } from "../domain/acceptance.js";
import { modelRefKey, type Actor, type ArtifactRef, type ModelRef } from "../domain/common.js";
import type { Event } from "../domain/event.js";
import {
  type Finding,
  type FindingValidation,
  type ValidationMethod,
  type ValidationVerdict,
} from "../domain/finding.js";
import { PolishError } from "../shared/errors.js";

export const DEBATE_STARTED = "finding.debate_started";
export const DEBATE_ARGUMENT = "finding.debate_argument";
export const DEBATE_OUTCOME = "finding.debate_outcome";
export const DEBATE_METHOD = "finding_debate" as const satisfies ValidationMethod;

export const DEBATE_ROLES = ["prosecutor", "defender", "judge"] as const;
export type DebateRole = (typeof DEBATE_ROLES)[number];

export interface DebateRoles {
  prosecutor: ModelRef;
  defender: ModelRef;
  judge: ModelRef;
  /** Judges of further families, asked in order when the judge's verdict cannot be read. */
  judgeAlternates?: ModelRef[];
}

export interface DebateArgumentRecord {
  findingId: string;
  checkpointHash: string;
  role: DebateRole;
  roundIndex: number;
  text: string;
}

export interface DebateStartedPayload {
  findingId: string;
  checkpointHash: string;
  roles: DebateRoles;
  causalValidationId: string;
}

export interface DebateOutcomePayload {
  findingId: string;
  checkpointHash: string;
  verdict: ValidationVerdict;
  rationale: string;
  roundCount: number;
  hardFailure: boolean;
  causalRefs: string[];
}

export interface DebateStep {
  role: DebateRole;
  roundIndex: number;
}

/** Debate may start only after a persisted B5 UNCERTAIN validation. */
export function assertDebateMayStart(finding: Finding): void {
  if (finding.status !== "UNCERTAIN") {
    throw new PolishError("INVARIANT_VIOLATION", `finding debate requires UNCERTAIN, got ${finding.status}`, {
      findingId: finding.id,
      status: finding.status,
    });
  }
}

export function debateKey(findingId: string, checkpointHash: string): string {
  return `${findingId}:${checkpointHash}`;
}

export function sameDebateKey(
  payload: { findingId?: unknown; checkpointHash?: unknown },
  findingId: string,
  checkpointHash: string,
): boolean {
  return payload.findingId === findingId && payload.checkpointHash === checkpointHash;
}

/**
 * Three distinct ModelRefs, and three distinct families when `familyOf` is given: a judge from
 * the prosecutor's family is that family agreeing with itself.
 */
export function threeDistinctDebateRoles(roles: DebateRoles, familyOf?: (ref: ModelRef) => string): boolean {
  const refs = [roles.prosecutor, roles.defender, roles.judge];
  const keys = refs.map(modelRefKey);
  if (!keys.every((key) => key.length > 0) || new Set(keys).size !== 3) return false;
  return familyOf === undefined || new Set(refs.map(familyOf)).size === 3;
}

export function debateActor(role: DebateRole, model: ModelRef): Actor {
  return { kind: role, role, model };
}

export function collectPreDebateEvidenceRefs(
  finding: Finding,
  validations: readonly FindingValidation[],
): ArtifactRef[] {
  const seen = new Set<string>();
  const refs: ArtifactRef[] = [];
  const add = (ref: ArtifactRef): void => {
    if (seen.has(ref.sha256)) return;
    seen.add(ref.sha256);
    refs.push(ref);
  };
  for (const validation of validations) {
    if (validation.findingId !== finding.id) continue;
    if (validation.method === DEBATE_METHOD) continue;
    for (const ref of validation.evidenceRefs) add(ref);
  }
  return refs;
}

export function deriveDebateCorpusKind(
  validations: readonly FindingValidation[],
  preDebateRefs: readonly ArtifactRef[],
): CorpusEntryKind {
  const methods = validations.filter((item) => item.method !== DEBATE_METHOD).map((item) => item.method);
  if (methods.includes("failing_test") || preDebateRefs.some((ref) => isRegressionArtifact(ref.kind))) {
    return "regression_test";
  }
  if (methods.includes("runtime_evidence") || preDebateRefs.some((ref) => isRuntimeArtifact(ref.kind))) {
    return "runtime_evidence";
  }
  if (methods.includes("static_proof") || preDebateRefs.some((ref) => ref.kind === "check_output" || ref.kind === "static_proof")) {
    return "check_config";
  }
  return "runtime_scenario";
}

function isRegressionArtifact(kind: string): boolean {
  return kind === "test_output" || kind === "failing_test" || kind === "regression_test";
}

function isRuntimeArtifact(kind: string): boolean {
  return kind === "runtime_evidence" || kind === "runtime_scenario" || kind.startsWith("runtime");
}

export function parseJudgeVerdict(content: string): { verdict: ValidationVerdict; rationale: string } | null {
  const trimmed = content.trim();
  if (trimmed === "") return null;
  const json = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    (parsed["verdict"] !== "VALID" && parsed["verdict"] !== "REJECTED" && parsed["verdict"] !== "UNCERTAIN") ||
    typeof parsed["rationale"] !== "string" ||
    parsed["rationale"].trim() === ""
  ) {
    return null;
  }
  return { verdict: parsed["verdict"], rationale: parsed["rationale"].trim() };
}

export function debateEventsFor(
  events: readonly Event[],
  findingId: string,
  checkpointHash: string,
): { started: Event | null; arguments: Event[]; outcome: Event | null } {
  let started: Event | null = null;
  let outcome: Event | null = null;
  const arguments_: Event[] = [];
  for (const event of events) {
    if (!sameDebateKey(event.payload, findingId, checkpointHash)) continue;
    if (event.type === DEBATE_STARTED) started = event;
    if (event.type === DEBATE_ARGUMENT) arguments_.push(event);
    if (event.type === DEBATE_OUTCOME) outcome = event;
  }
  return { started, arguments: arguments_, outcome };
}

export function debateValidationFor(
  validations: readonly FindingValidation[],
  findingId: string,
): FindingValidation | null {
  return validations.find((item) => item.findingId === findingId && item.method === DEBATE_METHOD) ?? null;
}

export function causalB5ValidationId(events: readonly Event[], findingId: string): string | null {
  let found: string | null = null;
  for (const event of events) {
    if (event.type !== "finding.validated") continue;
    const validation = event.payload["validation"] as FindingValidation | undefined;
    if (validation?.findingId !== findingId || validation.method === DEBATE_METHOD) continue;
    if (validation.verdict !== "UNCERTAIN") continue;
    found = event.id;
  }
  return found;
}

export function argumentRecords(events: readonly Event[]): DebateArgumentRecord[] {
  return events
    .filter((event) => event.type === DEBATE_ARGUMENT)
    .map((event) => event.payload as unknown as DebateArgumentRecord)
    .sort((a, b) => a.roundIndex - b.roundIndex || DEBATE_ROLES.indexOf(a.role) - DEBATE_ROLES.indexOf(b.role));
}

/** Next unfinished role, or terminal when a verdict exists / rounds are exhausted. */
export function nextDebateStep(
  records: readonly DebateArgumentRecord[],
  maxRounds: number,
): DebateStep | { done: true; lastVerdict: ValidationVerdict | null; hardFailure?: boolean } {
  for (let roundIndex = 1; roundIndex <= maxRounds; roundIndex++) {
    for (const role of DEBATE_ROLES) {
      const existing = records.find((item) => item.roundIndex === roundIndex && item.role === role);
      if (existing === undefined) return { role, roundIndex };
    }
    const judge = records.find((item) => item.roundIndex === roundIndex && item.role === "judge");
    const parsed = judge === undefined ? null : parseJudgeVerdict(judge.text);
    if (parsed === null) return { done: true, lastVerdict: "UNCERTAIN", hardFailure: true };
    if (parsed.verdict === "VALID" || parsed.verdict === "REJECTED") {
      return { done: true, lastVerdict: parsed.verdict };
    }
  }
  const lastJudge = [...records].reverse().find((item) => item.role === "judge");
  const parsed = lastJudge === undefined ? null : parseJudgeVerdict(lastJudge.text);
  return { done: true, lastVerdict: parsed?.verdict ?? "UNCERTAIN" };
}

export function rolePrompt(
  role: DebateRole,
  finding: Finding,
  validations: readonly FindingValidation[],
  preDebateRefs: readonly ArtifactRef[],
  records: readonly DebateArgumentRecord[],
  roundIndex: number,
): string {
  const evidenceBound = {
    finding: evidenceBoundFinding(finding),
    priorValidations: validations
      .filter((item) => item.findingId === finding.id && item.method !== DEBATE_METHOD)
      .map((item) => ({
        id: item.id,
        method: item.method,
        verdict: item.verdict,
        rationale: item.rationale,
        evidenceRefs: item.evidenceRefs,
      })),
    evidenceRefs: preDebateRefs,
    roundIndex,
  };
  if (role === "prosecutor") {
    return [
      "Prosecutor in an evidence-bound software finding debate.",
      "Argue VALID using only the supplied finding fields, prior validations, and artifact refs.",
      "Do not invent file paths, command output, or reproduction steps.",
      "Free-text persuasion cannot create evidence refs.",
      JSON.stringify(evidenceBound),
    ].join("\n");
  }
  const prosecution = records.find((item) => item.roundIndex === roundIndex && item.role === "prosecutor")?.text ?? "";
  if (role === "defender") {
    return [
      "Defender in an evidence-bound software finding debate.",
      "Challenge weak or non-reproducible claims. Prefer REJECTED or residual UNCERTAIN over false VALID.",
      "Cite only supplied evidence. Do not invent facts.",
      JSON.stringify({ ...evidenceBound, prosecution }),
    ].join("\n");
  }
  const defense = records.find((item) => item.roundIndex === roundIndex && item.role === "defender")?.text ?? "";
  return [
    "Judge an evidence-bound software finding debate.",
    "Decide from arguments plus persisted evidence only. Do not invent evidence refs.",
    'Return JSON only: {"verdict":"VALID|REJECTED|UNCERTAIN","rationale":"non-empty explanation"}.',
    JSON.stringify({ ...evidenceBound, prosecution, defense }),
  ].join("\n");
}

function evidenceBoundFinding(finding: Finding): Omit<Finding, never> {
  return finding;
}

export function startedPayload(event: Event): DebateStartedPayload {
  return event.payload as unknown as DebateStartedPayload;
}

export function outcomePayload(event: Event): DebateOutcomePayload {
  return event.payload as unknown as DebateOutcomePayload;
}

export function legalDebateValid(preDebateRefs: readonly ArtifactRef[]): boolean {
  return preDebateRefs.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
