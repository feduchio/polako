import { AmbiguitySchema, RequirementSchema, type Requirement } from "../domain/mission.js";
import { PolishError } from "../shared/errors.js";

export const PLANNER_INTAKE_SCHEMA = {
  name: "MissionInterpretation.requirements",
  version: 1,
} as const;

export interface SchemaIssue {
  path: string;
  message: string;
}

export type PlannerIntakeValidation =
  | { ok: true; requirements: Requirement[] }
  | { ok: false; issues: SchemaIssue[] };

/** Validate the planner intake `proposal` against the Fable/B7 requirement contract. */
export function validatePlannerIntakeProposal(proposal: unknown): PlannerIntakeValidation {
  if (!isRecord(proposal)) {
    return { ok: false, issues: [{ path: "$.proposal", message: "expected object" }] };
  }
  const raw = proposal["requirements"];
  if (!Array.isArray(raw)) {
    return { ok: false, issues: [{ path: "$.requirements", message: "expected array" }] };
  }
  if (raw.length === 0) {
    return { ok: false, issues: [{ path: "$.requirements", message: "expected a non-empty array of requirement objects" }] };
  }
  const requirements: Requirement[] = [];
  const issues: SchemaIssue[] = [];
  for (let index = 0; index < raw.length; index++) {
    const parsed = RequirementSchema.safeParse(raw[index]);
    if (!parsed.success) {
      issues.push(...formatZodIssues(parsed.error, `$.requirements[${index}]`));
      continue;
    }
    requirements.push(parsed.data);
  }
  const ambiguities = proposal["ambiguities"];
  if (ambiguities !== undefined) {
    if (!Array.isArray(ambiguities)) {
      issues.push({ path: "$.ambiguities", message: "expected array" });
    } else {
      for (let index = 0; index < ambiguities.length; index++) {
        const parsed = AmbiguitySchema.safeParse(ambiguities[index]);
        if (!parsed.success) issues.push(...formatZodIssues(parsed.error, `$.ambiguities[${index}]`));
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, requirements };
}

export function formatZodIssues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }, prefix: string): SchemaIssue[] {
  return error.issues.map((issue) => ({
    path: joinPath(prefix, issue.path),
    message: issue.message,
  }));
}

export function summarizeIssues(issues: readonly SchemaIssue[]): string {
  const first = issues[0];
  if (first === undefined) return "invalid structured output";
  return `${first.path} ${first.message}`;
}

export function outputContractError(message: string, details: Record<string, unknown> = {}): PolishError {
  return new PolishError("OUTPUT_CONTRACT", message, { schema: PLANNER_INTAKE_SCHEMA, ...details });
}

function joinPath(prefix: string, path: readonly PropertyKey[]): string {
  let result = prefix;
  for (const part of path) {
    result += typeof part === "number" ? `[${part}]` : `.${String(part)}`;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
