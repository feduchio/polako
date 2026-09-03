import { z } from "zod";
import { ActorSchema, IdSchema, Sha256Schema, TimestampSchema } from "./common.js";
import { hashJson } from "../shared/hash.js";

/**
 * Raw mission: the user's words, stored before any analysis and never modified.
 * `hash` covers `text`, `projectPath` and user-provided constraints; any later
 * understanding lives in MissionInterpretation versions.
 */
export const MissionSchema = z.object({
  id: IdSchema,
  projectPath: z.string().min(1),
  projectAlias: z.string().min(1).nullable(),
  text: z.string().min(1),
  /** explicit user-provided constraints and decisions agents may not override */
  userConstraints: z.array(z.string()),
  userDecisions: z.array(z.string()),
  createdAt: TimestampSchema,
  hash: Sha256Schema,
});
export type Mission = z.infer<typeof MissionSchema>;

export function missionHash(input: Pick<Mission, "projectPath" | "text" | "userConstraints" | "userDecisions">): string {
  return hashJson({
    projectPath: input.projectPath,
    text: input.text,
    userConstraints: input.userConstraints,
    userDecisions: input.userDecisions,
  });
}

export function createMission(input: {
  id: string;
  projectPath: string;
  projectAlias?: string | null;
  text: string;
  userConstraints?: string[];
  userDecisions?: string[];
  createdAt: number;
}): Mission {
  const base = {
    projectPath: input.projectPath,
    text: input.text,
    userConstraints: input.userConstraints ?? [],
    userDecisions: input.userDecisions ?? [],
  };
  return MissionSchema.parse({
    id: input.id,
    projectAlias: input.projectAlias ?? null,
    createdAt: input.createdAt,
    hash: missionHash(base),
    ...base,
  });
}

/** True when the stored mission still matches its own hash (tamper/corruption check). */
export function missionIsIntact(mission: Mission): boolean {
  return missionHash(mission) === mission.hash;
}

export const RequirementSchema = z.object({
  /** stable reference used by tasks with origin=mission_requirement, e.g. "R1" */
  ref: z.string().regex(/^R\d+$/),
  statement: z.string().min(1),
  /** how the system will know this is satisfied */
  acceptance: z.array(z.string().min(1)).min(1),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const AmbiguitySchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2),
  /** if true the run must stop with NEEDS_HUMAN before executing */
  blocking: z.boolean(),
});
export type Ambiguity = z.infer<typeof AmbiguitySchema>;

/**
 * Project-aware understanding of the mission. Built only after project discovery and the
 * baseline snapshot exist (both are referenced). Versioned: a new interpretation never
 * mutates an older one; the raw Mission is never touched.
 */
export const MissionInterpretationSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  version: z.number().int().positive(),
  supersedes: IdSchema.nullable(),
  basedOn: z.object({
    profileHash: Sha256Schema,
    baselineId: IdSchema,
  }),
  goals: z.array(z.string().min(1)).min(1),
  requirements: z.array(RequirementSchema).min(1),
  constraints: z.array(z.string()),
  nonGoals: z.array(z.string()),
  definitionOfSuccess: z.array(z.string().min(1)).min(1),
  ambiguities: z.array(AmbiguitySchema),
  createdBy: ActorSchema,
  createdAt: TimestampSchema,
});
export type MissionInterpretation = z.infer<typeof MissionInterpretationSchema>;

export function hasBlockingAmbiguity(interpretation: MissionInterpretation): boolean {
  return interpretation.ambiguities.some((a) => a.blocking);
}
