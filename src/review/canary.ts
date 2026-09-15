import { isBudgetError } from "../broker/quota.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { modelRefKey, type ModelRef } from "../domain/common.js";
import type { ProtocolRegistry } from "../protocols/loader.js";
import { PolishError, isAbortError } from "../shared/errors.js";
import type { CheckpointReviewArtifact } from "./artifact.js";
import { runAxisReview, type ReviewProvider } from "./swarm.js";

function isCancellation(error: unknown): boolean {
  return isAbortError(error) || (error instanceof PolishError && error.code === "CANCELLED");
}

/**
 * A diff with one planted defect, used to ask a reviewer the only question that makes a clean
 * verdict falsifiable: can you find anything at all?
 *
 * `docs/RECOVERY.md` §1.1 — over twelve days and twenty runs the `findings` table held zero rows
 * and every recorded clean round had `rawFindings: 0`, and both `DONE` verdicts were reached
 * exactly the way the founding document forbids: the model said it was fine.
 *
 * The defect is an off-by-one that dereferences one past the end. It is deliberately the most
 * ordinary bug there is: a reviewer that misses it has told us nothing about the code it passed.
 */
export const CANARY_DIFF = `--- a/src/cache.ts
+++ b/src/cache.ts
@@ -1,3 +1,12 @@
 const TTL_MS = 60_000;
 
 export interface Entry { key: string; touchedAt: number }
+
+/** Drop entries that have not been touched within the TTL. */
+export function evictStale(entries: Entry[], now: number): Entry[] {
+  const kept: Entry[] = [];
+  for (let i = 0; i <= entries.length; i++) {
+    if (now - entries[i].touchedAt < TTL_MS) kept.push(entries[i]);
+  }
+  return kept;
+}
`;

/** A valid 40-hex commit hash that no repository will hold. `GitHashSchema` accepts hex only. */
export const CANARY_COMMIT = "ca4a24" + "0".repeat(32) + "ca";

/**
 * Where the planted defect is, in the post-image of `CANARY_DIFF`: line 8 is the loop header whose
 * bound is wrong, line 9 is the dereference that goes out of bounds. Naming both is not slack — a
 * correct reviewer may cite either — but the window stops there. Widened to the whole function it
 * would accept a complaint about the comment, which is the defect round 1 found in this oracle.
 */
export const CANARY_DEFECT = { path: "src/cache.ts", firstLine: 8, lastLine: 9 } as const;

/** `a/src/cache.ts`, `b/src/cache.ts` and `./src/cache.ts` are the same file as `src/cache.ts`. */
function samePath(reported: string): boolean {
  return reported.replace(/^\.?\/?/, "").replace(/^[ab]\//, "") === CANARY_DEFECT.path;
}

export const CANARY_EVENT_TYPE = "review.canary_recorded";

export interface ReviewerCanaryResult {
  model: ModelRef;
  /** How many findings came back. Zero is the failure this exists to catch. */
  findings: number;
  /** How many of them point at the planted defect. */
  located: number;
  verified: boolean;
  promptDigest: string;
  error?: string;
}

/** Verified models, from a run's own event log. Read by both the clean-round gate and the DONE gate. */
export function canaryVerdicts(events: readonly { type: string; payload: Record<string, unknown> }[]): Map<string, boolean> {
  const verdicts = new Map<string, boolean>();
  for (const event of events) {
    if (event.type !== CANARY_EVENT_TYPE) continue;
    const model = event.payload["model"];
    if (typeof model !== "object" || model === null) continue;
    verdicts.set(modelRefKey(model as ModelRef), event.payload["verified"] === true);
  }
  return verdicts;
}

/**
 * One reviewer, one seeded defect, through the same call path a real review takes — same prompt
 * composition, same response schema, same parsing and the same shape normalisation. That identity
 * is the point: `docs/RECOVERY.md` §1.2 records a schema normalisation that has been shipped since
 * 12 September and never once executed in production, because no run reached `REVIEWING` after it
 * landed. A canary that used a shorter path would verify the wrong thing.
 */
export async function runReviewerCanary(input: {
  provider: ReviewProvider;
  protocols: ProtocolRegistry;
  runId: string;
  now: number;
  maxOutputTokens?: number;
}): Promise<ReviewerCanaryResult> {
  const checkpoint = canaryCheckpoint(input.runId, input.now);
  const artifact: CheckpointReviewArtifact = {
    commitHash: CANARY_COMMIT,
    diffBase: null,
    diff: CANARY_DIFF,
    checkpoint,
  };
  try {
    const result = await runAxisReview({
      checkpoint,
      axis: "correctness",
      artifact,
      provider: input.provider,
      protocols: input.protocols,
      now: input.now,
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    });
    // Counting findings is not enough: a reviewer that answers "something is wrong" to anything
    // passes that, and its clean verdict still carries no information. A finding has to point at
    // the planted defect.
    const located = result.findings.filter((finding) =>
      finding.evidence.some((entry) =>
        samePath(entry.path) &&
        entry.line !== undefined &&
        entry.line >= CANARY_DEFECT.firstLine &&
        entry.line <= CANARY_DEFECT.lastLine)).length;
    return {
      model: result.model,
      findings: result.findings.length,
      located,
      verified: located > 0,
      promptDigest: result.promptDigest,
    };
  } catch (error) {
    // The run has no money left, or is being cancelled. Neither is a statement about the reviewer,
    // and recording one as a verdict would make it permanent: the verdict cache never retries.
    if (isBudgetError(error) || isCancellation(error)) throw error;
    // A reviewer that could not be asked is not a reviewer that answered. Unverified either way:
    // the whole point is that a clean round must be earned, and silence is not an answer.
    return {
      model: input.provider.model,
      findings: 0,
      located: 0,
      verified: false,
      promptDigest: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * No repository root is given to `runAxisReview`, so evidence paths are not checked against a
 * checkout — the canary counts findings, and a finding's evidence strength is not what it asks.
 */
function canaryCheckpoint(runId: string, now: number): Checkpoint {
  return {
    id: "ckpt_0000000000000000canary",
    runId,
    seq: 0,
    commitHash: CANARY_COMMIT,
    parentId: null,
    source: "integration",
    taskId: null,
    evidence: {
      gates: {},
      testsPassed: 0,
      testsFailed: 0,
      testsTotal: 0,
      openValidatedFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      diffLinesFromBaseline: 0,
    },
    createdAt: now,
  };
}
