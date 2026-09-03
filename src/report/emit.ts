import { SYSTEM_ACTOR } from "../domain/common.js";
import type { ArtifactRef } from "../domain/common.js";
import type { NewEvent } from "../domain/event.js";
import type { TerminalReason } from "../domain/run.js";
import { id } from "../shared/ids.js";
import {
  buildFinalReportInput,
  buildInterimReportInput,
  buildNeedsHumanReportInput,
  type ReportContext,
} from "./build.js";
import {
  renderFinalReport,
  renderInterimReport,
  renderNeedsHumanReport,
  type InterimReportInput,
} from "./reports.js";

export type ReportKind = "final" | "needs_human" | "interim";

export interface EmitReportInput {
  kind: ReportKind;
  terminalReason?: TerminalReason;
  interim?: InterimReportInput;
  causedBy?: string[];
}

/** Persist a report artifact and append `report.generated` without touching the user tree. */
export function emitReport(ctx: ReportContext, input: EmitReportInput): ArtifactRef {
  let body: string;
  let label: string;

  switch (input.kind) {
    case "final":
      body = renderFinalReport(buildFinalReportInput(ctx));
      label = `final:${ctx.run.id}`;
      break;
    case "needs_human": {
      const reason = input.terminalReason;
      if (reason === undefined) throw new RangeError("needs_human report requires terminalReason");
      body = renderNeedsHumanReport(buildNeedsHumanReportInput(reason));
      label = `needs_human:${ctx.run.id}`;
      break;
    }
    case "interim":
      body = renderInterimReport(input.interim ?? buildInterimReportInput(ctx));
      label = `interim:${ctx.run.id}`;
      break;
  }

  const ref = ctx.store.artifacts.put(body, "report.generated", label, ctx.clock.now());
  const event: NewEvent = {
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "report.generated",
    payload: {
      kind: input.kind,
      checkpointHash: ctx.run.currentCheckpointHash,
      reportRef: ref.sha256,
      ...(input.kind === "needs_human" && input.terminalReason !== undefined
        ? {
            question: input.terminalReason.question ?? input.terminalReason.summary,
            options: input.terminalReason.options ?? [],
            summary: input.terminalReason.summary,
            code: input.terminalReason.code,
          }
        : {}),
    },
    causedBy: input.causedBy ?? [],
    actor: SYSTEM_ACTOR,
    artifacts: [ref],
  };
  ctx.store.events.append([event]);
  return ref;
}

export function emitNeedsHumanReport(
  ctx: ReportContext,
  reason: TerminalReason,
  causedBy: string[] = [],
): ArtifactRef {
  return emitReport(ctx, { kind: "needs_human", terminalReason: reason, causedBy });
}

export function emitFinalReport(ctx: ReportContext, causedBy: string[] = []): ArtifactRef {
  return emitReport(ctx, { kind: "final", causedBy });
}
