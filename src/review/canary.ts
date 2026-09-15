import type { Checkpoint } from "../domain/checkpoint.js";
import type { ModelRef } from "../domain/common.js";
import type { ProtocolRegistry } from "../protocols/loader.js";
import type { CheckpointReviewArtifact } from "./artifact.js";
import { runAxisReview, type ReviewProvider } from "./swarm.js";

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

export interface ReviewerCanaryResult {
  model: ModelRef;
  /** How many findings came back. Zero is the failure this exists to catch. */
  findings: number;
  verified: boolean;
  promptDigest: string;
  error?: string;
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
    return {
      model: result.model,
      findings: result.findings.length,
      verified: result.findings.length > 0,
      promptDigest: result.promptDigest,
    };
  } catch (error) {
    // A reviewer that could not be asked is not a reviewer that answered. Unverified either way:
    // the whole point is that a clean round must be earned, and silence is not an answer.
    return {
      model: input.provider.model,
      findings: 0,
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
