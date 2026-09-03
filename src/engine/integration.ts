import type { MissionAcceptanceCorpus } from "../domain/acceptance.js";
import type { GateResult } from "../project/checkRunner.js";
import type { CommandPolicy } from "../sandbox/allowlist.js";
import { Git } from "../sandbox/git.js";
import type { Sandbox, SandboxHandle } from "../sandbox/worktree.js";
import { errorToString } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import type { CandidateGates } from "./candidates.js";
import { runGates } from "./candidates.js";

/**
 * Atomic boundary for the durable run branch/checkpoint. Implementations must change the
 * head only when it still equals `expected`; this prevents a successfully-gated stale
 * workspace from overwriting a newer integration.
 */
export interface RunHead {
  read(): Promise<string>;
  compareAndSet(expected: string, next: string): Promise<boolean>;
}

/** Git-backed run head using update-ref's old-value compare-and-set. */
export class GitBranchRunHead implements RunHead {
  private readonly git: Git;

  constructor(repoPath: string, private readonly branch: string) {
    this.git = new Git(repoPath);
  }

  read(): Promise<string> {
    return this.git.revParse(this.branch);
  }

  async compareAndSet(expected: string, next: string): Promise<boolean> {
    const update = await this.git.run(
      ["update-ref", `refs/heads/${this.branch}`, next, expected],
      { allowFailure: true },
    );
    return update.exitCode === 0;
  }
}

export type IntegrationStatus =
  | "integrated"
  | "conflict"
  | "failed_gates"
  | "stale_head"
  | "error";

export interface IntegrationResult {
  status: IntegrationStatus;
  previousHead: string;
  integratedCommit: string | null;
  gateResult: GateResult | null;
  conflicts: string[];
  advanced: boolean;
  error: string | null;
}

export interface IntegrateWinnerInput {
  runId: string;
  winnerCommit: string;
  sandbox: Sandbox;
  policy: CommandPolicy;
  gates: CandidateGates;
  corpus?: MissionAcceptanceCorpus;
  runHead: RunHead;
  projectEnv?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Serial Temporary Integration Workspace flow. Neither cherry-picking nor gates touch the
 * user's checkout. The durable head is advanced only after all integration gates pass.
 */
export function integrateWinner(input: IntegrateWinnerInput): Promise<IntegrationResult> {
  return integrationLane.run(() => integrateWinnerExclusive(input));
}

class SerialLane {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const integrationLane = new SerialLane();

async function integrateWinnerExclusive(input: IntegrateWinnerInput): Promise<IntegrationResult> {
  const previousHead = await input.runHead.read();
  let workspace: SandboxHandle | null = null;
  let integratedCommit: string | null = null;
  try {
    workspace = await input.sandbox.create({
      id: `${id("job")}-integration`,
      baseCommit: previousHead,
      policy: input.policy,
      ...(input.projectEnv === undefined ? {} : { projectEnv: input.projectEnv }),
    });
    const applied = await workspace.git.cherryPick(input.winnerCommit);
    if (!applied.ok) {
      return {
        status: "conflict",
        previousHead,
        integratedCommit: null,
        gateResult: null,
        conflicts: applied.conflicts,
        advanced: false,
        error: null,
      };
    }

    integratedCommit = await workspace.commitAll(`polish: integrate ${input.winnerCommit}`);
    integratedCommit ??= previousHead;
    const gateResult = await runGates({
      runId: input.runId,
      commitHash: integratedCommit,
      sandbox: workspace,
      gates: input.gates,
      ...(input.corpus === undefined ? {} : { corpus: input.corpus }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!gateResult.passed) {
      return {
        status: "failed_gates",
        previousHead,
        integratedCommit,
        gateResult,
        conflicts: [],
        advanced: false,
        error: null,
      };
    }

    const advanced = await input.runHead.compareAndSet(previousHead, integratedCommit);
    return {
      status: advanced ? "integrated" : "stale_head",
      previousHead,
      integratedCommit,
      gateResult,
      conflicts: [],
      advanced,
      error: null,
    };
  } catch (error) {
    return {
      status: "error",
      previousHead,
      integratedCommit,
      gateResult: null,
      conflicts: [],
      advanced: false,
      error: errorToString(error),
    };
  } finally {
    if (workspace !== null) {
      try {
        await workspace.destroy();
      } catch {
        // Cleanup must not change whether the durable run head advanced.
      }
    }
  }
}
