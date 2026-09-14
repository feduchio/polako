import { z } from "zod";
import type { CompletionRequest, CompletionResponse } from "../broker/types.js";
import type { ModelRef } from "../domain/common.js";
import type { Event, NewEvent } from "../domain/event.js";
import type { MissionInterpretation } from "../domain/mission.js";
import type { Task } from "../domain/task.js";

export const CouncilRoleSchema = z.enum(["planner", "scope_guardian", "judge"]);
export type CouncilRole = z.infer<typeof CouncilRoleSchema>;

export interface CouncilCompletionClient {
  complete(request: CompletionRequest): Promise<CompletionResponse | { response: CompletionResponse; eventId: string }>;
}

export interface CouncilRoleConfig {
  client: CouncilCompletionClient;
  model: ModelRef;
  /** Preference chain; defaults to `[model]` when omitted. */
  models?: readonly ModelRef[];
  /** `routing.disableReasoning`. Omitted is the default arm: the field is not sent at all. */
  disableReasoning?: boolean;
}

export type CouncilRoleConfigs = Record<CouncilRole, CouncilRoleConfig>;

export const RoleOpinionSchema = z.object({
  role: CouncilRoleSchema,
  decision: z.enum(["approve", "revise", "needs_human"]),
  rationale: z.string().min(1),
  concerns: z.array(z.string()),
});
export type RoleOpinion = z.infer<typeof RoleOpinionSchema>;

export interface CouncilDecision {
  decision: "APPROVED" | "NEEDS_HUMAN";
  rationale: string;
  opinions: RoleOpinion[];
  events: Event[];
}

export type IntakeResult =
  | { status: "READY"; interpretation: MissionInterpretation; decision: CouncilDecision }
  | {
      status: "NEEDS_HUMAN";
      interpretation: MissionInterpretation | null;
      decision: CouncilDecision;
      question: string;
      options: string[];
    };

export interface TaskDag {
  tasks: Task[];
  roots: string[];
  droppedRequirementRefs: string[];
  decision: CouncilDecision;
}

export interface CouncilEventSink {
  append(events: readonly NewEvent[]): Event[];
}
