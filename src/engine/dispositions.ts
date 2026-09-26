import { tallyDispositions, type DispositionTally } from "../convergence/dispositions.js";
import type { Finding, FindingValidation } from "../domain/finding.js";
import { INVESTIGATION_EVENT } from "./investigation.js";
import type { PhaseContext } from "./types.js";

/** The run's findings by disposition, or only those raised on `checkpointHash`. */
export function runDispositions(ctx: PhaseContext, checkpointHash?: string): DispositionTally {
  const findings = ctx.store.repos.findings.listByRun(ctx.run.id)
    .filter((finding) => checkpointHash === undefined || finding.checkpointHash === checkpointHash);
  return tallyDispositions({
    findings,
    latestValidation: latestValidations(ctx, findings),
    investigationReason: investigationReasons(ctx),
  });
}

/** Blocking findings no execution settled, with why: what a DONE resting on them must say. */
export function unexaminedBlockingFindings(ctx: PhaseContext): { finding: Finding; reason: string }[] {
  const reasons = investigationReasons(ctx);
  return ctx.store.repos.findings.listByRun(ctx.run.id)
    .filter((finding) => finding.blocking && finding.status === "UNCERTAIN")
    .map((finding) => ({
      finding,
      reason: reasons.get(finding.id) ?? ctx.store.repos.validations.listByFinding(finding.id).at(-1)?.reason ?? "no_executable_reproduction",
    }));
}

function latestValidations(ctx: PhaseContext, findings: readonly Finding[]): Map<string, FindingValidation> {
  const latest = new Map<string, FindingValidation>();
  for (const finding of findings) {
    const validation = ctx.store.repos.validations.listByFinding(finding.id).at(-1);
    if (validation !== undefined) latest.set(finding.id, validation);
  }
  return latest;
}

/** An attempt that never reached the judge (worker, checkout or re-run failed) records only its text. */
function investigationReasons(ctx: PhaseContext): Map<string, string> {
  const latest = new Map<string, { attempt: unknown; reason: string }>();
  for (const event of ctx.store.events.list(ctx.run.id, { types: [INVESTIGATION_EVENT] })) {
    const findingId = event.payload["findingId"];
    if (typeof findingId !== "string") continue;
    const attempt = event.payload["attempt"];
    const reason = event.payload["reason"];
    if (event.payload["outcome"] === "not_examined" && typeof reason === "string") {
      latest.set(findingId, { attempt, reason });
    } else if (event.payload["verdict"] === null && latest.get(findingId)?.attempt !== attempt) {
      latest.set(findingId, { attempt, reason: "worker_failed" });
    }
  }
  return new Map([...latest].map(([findingId, entry]) => [findingId, entry.reason]));
}
