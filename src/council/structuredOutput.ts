import type { CompletionRequest, CompletionResponse } from "../broker/types.js";
import type { ArtifactRef } from "../domain/common.js";
import type { NewEvent } from "../domain/event.js";
import type { Clock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import {
  PLANNER_INTAKE_SCHEMA,
  outputContractError,
  summarizeIssues,
  validatePlannerIntakeProposal,
  type SchemaIssue,
} from "./interpretationSchema.js";
import type { CouncilCompletionClient, CouncilEventSink } from "./types.js";

export const PLANNER_INTAKE_PURPOSE = "council_intake_planner";
const MAX_REPAIR_ATTEMPTS = 1;

export interface StructuredCouncilClientOptions {
  inner: CouncilCompletionClient;
  role: "planner";
  clock: Clock;
  eventSink?: CouncilEventSink;
  resolveResponseArtifact?: (eventId: string) => ArtifactRef | null;
}

/**
 * Validate planner intake JSON against the MissionInterpretation requirements contract.
 * One bounded repair on the same model; further failure is OUTPUT_CONTRACT (fallback-worthy).
 */
export function createStructuredCouncilClient(options: StructuredCouncilClientOptions): CouncilCompletionClient {
  return {
    async complete(request) {
      const raw = await options.inner.complete(request);
      if (request.metadata.purpose !== PLANNER_INTAKE_PURPOSE) return raw;
      const first = inspect(raw);
      if (first.ok) return raw;
      recordInvalid(options, request, first, "initial", 0, responseMeta(raw));
      recordRepair(options, request, 1);
      const repairRequest: CompletionRequest = {
        ...request,
        messages: [...request.messages, { role: "system", content: repairPrompt(first.issues) }],
        metadata: {
          ...request.metadata,
          purpose: PLANNER_INTAKE_PURPOSE,
        },
      };
      const repaired = await options.inner.complete(repairRequest);
      const second = inspect(repaired);
      if (second.ok) return repaired;
      recordInvalid(options, request, second, "repair", 1, responseMeta(repaired));
      throw outputContractError("planner interpretation requirements failed schema validation", {
        role: options.role,
        purpose: request.metadata.purpose,
        issues: second.issues,
        model: request.model,
        repairAttempt: 1,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
      });
    },
  };
}

function inspect(raw: CompletionResponse | { response: CompletionResponse; eventId: string }): PlannerInspect {
  const response = "response" in raw ? raw.response : raw;
  const content = response.message.content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(content));
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: "$", message: error instanceof Error ? error.message : "invalid JSON" }],
    };
  }
  const proposal = extractProposal(parsed);
  const validated = validatePlannerIntakeProposal(proposal);
  if (validated.ok) return { ok: true };
  return { ok: false, issues: validated.issues };
}

function recordInvalid(
  options: StructuredCouncilClientOptions,
  request: CompletionRequest,
  result: Extract<PlannerInspect, { ok: false }>,
  attempt: "initial" | "repair",
  repairAttempt: number,
  meta: { eventId?: string },
): void {
  if (options.eventSink === undefined) return;
  const artifact = meta.eventId === undefined ? null : (options.resolveResponseArtifact?.(meta.eventId) ?? null);
  const event: NewEvent = {
    id: id("evt", options.clock.now()),
    runId: request.metadata.runId,
    ts: options.clock.now(),
    type: "model.output_invalid",
    payload: {
      role: options.role,
      purpose: request.metadata.purpose,
      schema: PLANNER_INTAKE_SCHEMA,
      issues: result.issues,
      summary: summarizeIssues(result.issues),
      model: request.model,
      responseEventId: meta.eventId ?? null,
      responseArtifact: artifact,
      attempt,
      repairAttempt,
      maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
    },
    causedBy: meta.eventId === undefined ? [] : [meta.eventId],
    actor: { kind: "supervisor", role: options.role, model: request.model },
    artifacts: artifact === null ? [] : [artifact],
  };
  options.eventSink.append([event]);
}

function recordRepair(options: StructuredCouncilClientOptions, request: CompletionRequest, repairAttempt: number): void {
  if (options.eventSink === undefined) return;
  const event: NewEvent = {
    id: id("evt", options.clock.now()),
    runId: request.metadata.runId,
    ts: options.clock.now(),
    type: "model.output_repair_attempted",
    payload: {
      role: options.role,
      purpose: request.metadata.purpose,
      schema: PLANNER_INTAKE_SCHEMA,
      attempt: repairAttempt,
      maxAttempts: MAX_REPAIR_ATTEMPTS,
      model: request.model,
    },
    causedBy: request.metadata.causedBy ?? [],
    actor: { kind: "supervisor", role: options.role, model: request.model },
    artifacts: [],
  };
  options.eventSink.append([event]);
}

function repairPrompt(issues: readonly SchemaIssue[]): string {
  const listed = issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
  return [
    `Your previous JSON failed ${PLANNER_INTAKE_SCHEMA.name} v${PLANNER_INTAKE_SCHEMA.version}.`,
    "Issues:",
    listed,
    "Return JSON only with keys decision, rationale, concerns, proposal.",
    'proposal.requirements MUST be a non-empty array of objects {"ref":"R1","statement":"...","acceptance":["observable criterion"]}.',
    "Do not return requirements as strings. Do not use acceptanceCriteria. Do not ask a human to fix JSON.",
  ].join("\n");
}

function extractProposal(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (isRecord(raw["proposal"])) return raw["proposal"];
  if ("requirements" in raw) return raw;
  return raw;
}

function responseMeta(raw: CompletionResponse | { response: CompletionResponse; eventId: string }): { eventId?: string } {
  return "eventId" in raw ? { eventId: raw.eventId } : {};
}

function stripFence(value: string): string {
  const trimmed = value.trim();
  return /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PlannerInspect = { ok: true } | { ok: false; issues: SchemaIssue[] };

