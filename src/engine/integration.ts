import type { MissionAcceptanceCorpus } from "../domain/acceptance.js";
import type { GateResult } from "../project/checkRunner.js";
import type { CommandPolicy } from "../sandbox/allowlist.js";
import { Git } from "../sandbox/git.js";
import type { Sandbox, SandboxHandle } from "../sandbox/worktree.js";
import { errorToString } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import type { CandidateGates } from "./candidates.js";
import { EnvironmentNotReadyError, runGates } from "./candidates.js";

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
  | "failed_runtime"
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
  /** Commit message of the integration commit; defaults to `polish: integrate <winner>`. */
  commitMessage?: string;
  /** Runs after integration gates pass, still on the temporary workspace, before CAS. */
  afterGates?: (input: { commitHash: string; workspace: SandboxHandle }) => Promise<boolean>;
}

/**
 * Serial Temporary Integration Workspace flow. Neither cherry-picking nor gates touch the
 * user's checkout. The durable head is advanced only after all integration gates pass.
 */
export function integrateWinner(input: IntegrateWinnerInput): Promise<IntegrationResult> {
  return runOnIntegrationLane(() => integrateWinnerExclusive(input));
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

/** Serializes run-head mutation (integration and rollback) onto the in-process integration lane. */
export function runOnIntegrationLane<T>(operation: () => Promise<T>): Promise<T> {
  return integrationLane.run(operation);
}

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

    integratedCommit = await workspace.commitAll(input.commitMessage ?? `polish: integrate ${input.winnerCommit}`);
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

    if (input.afterGates !== undefined) {
      const runtimeOk = await input.afterGates({ commitHash: integratedCommit, workspace });
      if (!runtimeOk) {
        return {
          status: "failed_runtime",
          previousHead,
          integratedCommit,
          gateResult,
          conflicts: [],
          advanced: false,
          error: "runtime validation failed on the integration workspace",
        };
      }
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
    // An unpreparable workspace is not an integration outcome: converting it to `status: "error"`
    // would hide it inside a per-integration result the driver reads as a normal failure, and the
    // run would retry the same fresh workspace on every tick. Finding 54.
    if (error instanceof EnvironmentNotReadyError) throw error;
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
