import { z } from "zod";
import { normalizeAcceptancePath } from "./acceptance.js";
import { ActorSchema, GitHashSchema, IdSchema, TimestampSchema, type Actor } from "./common.js";
import { PolishError } from "../shared/errors.js";

/** Explicit causal scope that waiver evidence events must carry and match exactly. */
export const WaiverValidatedScopeSchema = z.object({
  requirementId: z.string().min(1),
  taskId: IdSchema,
  baseCheckpointHash: GitHashSchema,
  relativePath: z.string().min(1),
  /** Optional extra validated paths; the full attested set must equal the waiver pathScope. */
  relativePaths: z.array(z.string().min(1)).min(1).optional(),
  findingKind: z.string().min(1),
});
export type WaiverValidatedScope = z.infer<typeof WaiverValidatedScopeSchema>;

export const WAIVER_EVIDENCE_EVENT_TYPES = ["finding.validated", "candidate.gated", "review.finished"] as const;
export type WaiverEvidenceEventType = (typeof WAIVER_EVIDENCE_EVENT_TYPES)[number];

export function isWaiverEvidenceEventType(type: string): type is WaiverEvidenceEventType {
  return (WAIVER_EVIDENCE_EVENT_TYPES as readonly string[]).includes(type);
}

export function normalizeWaiverPath(path: string): string {
  return normalizeAcceptancePath(path);
}

function normalizePathScope(paths: readonly string[]): string[] {
  const normalized = paths.map((path) => normalizeWaiverPath(path));
  if (new Set(normalized).size !== normalized.length) {
    throw new PolishError("INVARIANT_VIOLATION", "protected-change waiver path scope must not contain duplicates");
  }
  return normalized;
}

export const ProtectedChangeWaiverSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  missionId: IdSchema,
  taskId: IdSchema,
  /** Explicit task/mission requirement that authorizes this exceptional change. */
  requirementId: z.string().min(1),
  baseCheckpointHash: GitHashSchema,
  /** Exact protected paths; entries are neither prefixes nor globs. */
  pathScope: z.array(z.string().min(1)).min(1),
  /** Exact finding category authorized for those paths. */
  findingKind: z.string().min(1),
  justification: z.string().min(1),
  causeEventId: IdSchema,
  issuedBy: ActorSchema,
  validatedBy: ActorSchema,
  createdAt: TimestampSchema,
}).transform((waiver) => ({
  ...waiver,
  pathScope: normalizePathScope(waiver.pathScope),
})).superRefine((waiver, ctx) => {
  if (waiver.issuedBy.kind === "worker") {
    ctx.addIssue({ code: "custom", message: "workers cannot issue protected-change waivers", path: ["issuedBy"] });
  }
  if (waiver.validatedBy.kind === "worker") {
    ctx.addIssue({ code: "custom", message: "workers cannot validate protected-change waivers", path: ["validatedBy"] });
  }
  if (actorIdentity(waiver.issuedBy) === actorIdentity(waiver.validatedBy)) {
    ctx.addIssue({ code: "custom", message: "protected-change waiver requires independent validation", path: ["validatedBy"] });
  }
});
export type ProtectedChangeWaiver = z.infer<typeof ProtectedChangeWaiverSchema>;

export interface ProtectedChangeScope {
  runId: string;
  missionId: string;
  taskId: string;
  requirementId: string;
  baseCheckpointHash: string;
  relativePath: string;
  findingKind: string;
}

function actorIdentity(actor: Actor): string {
  return JSON.stringify(actor);
}

export function assertValidWaiverActors(issuedBy: Actor, validatedBy: Actor): void {
  if (issuedBy.kind === "worker" || validatedBy.kind === "worker") {
    throw new PolishError("INVARIANT_VIOLATION", "workers cannot issue or validate protected-change waivers");
  }
  if (actorIdentity(issuedBy) === actorIdentity(validatedBy)) {
    throw new PolishError("INVARIANT_VIOLATION", "protected-change waiver requires independent validation");
  }
}

/** Deny-by-default exact matching helper for a future worker-side gate. */
export function matchesProtectedChangeWaiver(
  waiver: ProtectedChangeWaiver,
  change: ProtectedChangeScope,
): boolean {
  assertValidWaiverActors(waiver.issuedBy, waiver.validatedBy);
  return waiver.runId === change.runId
    && waiver.missionId === change.missionId
    && waiver.taskId === change.taskId
    && waiver.requirementId === change.requirementId
    && waiver.baseCheckpointHash === change.baseCheckpointHash
    && waiver.pathScope.includes(normalizeWaiverPath(change.relativePath))
    && waiver.findingKind === change.findingKind;
}

export function extractWaiverEvidenceScope(event: { type: string; payload: Record<string, unknown> }): WaiverValidatedScope | null {
  if (!isWaiverEvidenceEventType(event.type)) return null;
  if (event.type === "review.finished" && Object.keys(event.payload).length === 0) return null;
  const parsed = WaiverValidatedScopeSchema.safeParse(event.payload["waiverScope"]);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    relativePath: normalizeWaiverPath(parsed.data.relativePath),
  };
}

/** Every path a validator attested to; one path cannot bless an arbitrary waiver list. */
export function evidenceValidatedPaths(scope: WaiverValidatedScope): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const path of [scope.relativePath, ...(scope.relativePaths ?? [])]) {
    const normalized = normalizeWaiverPath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique.sort();
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((path, index) => path === b[index]);
}

/** Evidence payload scope must match the waiver's declared requirement, task, checkpoint, finding kind, and exact path set. */
export function evidenceScopeMatchesWaiver(scope: WaiverValidatedScope, waiver: ProtectedChangeWaiver): boolean {
  return waiver.requirementId === scope.requirementId
    && waiver.taskId === scope.taskId
    && waiver.baseCheckpointHash === scope.baseCheckpointHash
    && waiver.findingKind === scope.findingKind
    && samePathSet(waiver.pathScope, evidenceValidatedPaths(scope));
}
