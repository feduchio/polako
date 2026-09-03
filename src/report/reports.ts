export interface InterimReportInput {
  action?: string;
  completed: readonly string[];
  inProgress: readonly string[];
  blockers?: readonly string[];
}

export interface FinalReportInput {
  summary: string;
  changes?: readonly string[];
  reasons?: readonly string[];
  rejected?: readonly string[];
  checks?: readonly string[];
  findings?: readonly string[];
  validation?: readonly string[];
  convergence?: readonly string[];
  evidence?: readonly string[];
}

export interface NeedsHumanReportInput {
  question: string;
  options: readonly string[];
  context?: string;
  recommendation?: string;
}

export function renderInterimReport(input: InterimReportInput): string {
  const lines = [`NEXT: ${input.action ?? "No action needed; work is continuing."}`];
  appendNumbered(lines, "Completed", input.completed);
  appendNumbered(lines, "In progress", input.inProgress);
  appendNumbered(lines, "Blocked", input.blockers ?? []);
  return lines.join("\n");
}

export function renderFinalReport(input: FinalReportInput): string {
  const lines = [`DONE: ${input.summary}`];
  appendNumbered(lines, "Changed", input.changes ?? []);
  appendNumbered(lines, "Why", input.reasons ?? []);
  appendNumbered(lines, "Rejected", input.rejected ?? []);
  appendNumbered(lines, "Verified", input.checks ?? []);
  appendNumbered(lines, "Findings", input.findings ?? []);
  appendNumbered(lines, "Validation", input.validation ?? []);
  appendNumbered(lines, "Convergence", input.convergence ?? []);
  appendNumbered(lines, "Evidence", input.evidence ?? []);
  return lines.join("\n");
}

/**
 * Action-first, bounded decision request. Numbering is deliberately flat and capped so the
 * user can answer with a single digit.
 */
export function renderNeedsHumanReport(input: NeedsHumanReportInput): string {
  const options = input.options
    .map((option) => option.trim())
    .filter((option) => option.length > 0)
    .slice(0, 5);
  if (options.length < 1) throw new RangeError("NEEDS_HUMAN requires at least one option");
  const lines = [`ACTION REQUIRED: ${input.question.trim()}`];
  if (input.context !== undefined && input.context.trim().length > 0) {
    lines.push(`Why: ${input.context.trim()}`);
  }
  options.forEach((option, index) => lines.push(`${index + 1}. ${option}`));
  if (input.recommendation !== undefined && input.recommendation.trim().length > 0) {
    lines.push(`Recommended: ${input.recommendation.trim()}`);
  }
  lines.push("Reply with a number.");
  return lines.join("\n");
}

export const interimReport = renderInterimReport;
export const finalReport = renderFinalReport;
export const needsHumanReport = renderNeedsHumanReport;

function appendNumbered(lines: string[], title: string, items: readonly string[]): void {
  const clean = items.map((item) => item.trim()).filter((item) => item.length > 0);
  if (clean.length === 0) return;
  lines.push(`${title}:`);
  clean.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
}
