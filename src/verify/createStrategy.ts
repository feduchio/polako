import { PairwiseJudge } from "./pairwise.js";
import type { VerifierStrategy } from "./strategy.js";

/** `empirical` is built in the daemon, where the broker and protocols exist. */
export function createVerifierStrategy(verifier: { backend: "ts" | "empirical" }): VerifierStrategy {
  if (verifier.backend === "empirical") {
    throw new Error("empirical verifier requires production broker and protocol injection");
  }
  return new PairwiseJudge();
}
