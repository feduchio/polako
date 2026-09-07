import { realpathSync } from "node:fs";
import type { Finding } from "../domain/finding.js";
import {
  ProjectFindingEvidenceWorker,
  type EvidenceAttempt,
  type FindingEvidenceWorker,
  type ProjectEvidenceWorkerOptions,
} from "../findings/index.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import type { Sandbox, SandboxHandle } from "../sandbox/worktree.js";
import { PolishError } from "../shared/errors.js";

const MAX_CREATE_ATTEMPTS = 3;

export function detachedCheckoutPolicy(): CommandPolicy {
  return CommandPolicy.forProject([], null, true);
}

export function uniqueCheckoutId(kind: "rev" | "val", key: string, seq: number): string {
  const compact = key.replace(/[^a-zA-Z0-9._-]/g, "").slice(-24);
  return `${kind}-${compact}-${seq}`;
}

export async function assertIsolatedCheckout(
  handle: SandboxHandle,
  projectPath: string,
  targetHash: string,
): Promise<void> {
  const checkoutReal = realpathSync(handle.path);
  const projectReal = realpathSync(projectPath);
  if (checkoutReal === projectReal) {
    throw new PolishError("SANDBOX_ERROR", "checkpoint checkout path must not equal run.projectPath", {
      checkout: checkoutReal,
      projectPath: projectReal,
    });
  }
  const head = await handle.headCommit();
  if (head !== targetHash) {
    throw new PolishError("SANDBOX_ERROR", `checkpoint checkout HEAD ${head} does not match ${targetHash}`, {
      head,
      targetHash,
    });
  }
}

/** Create a disposable checkpoint checkout; retry with a unique id if a stale path CONFLICTS. */
export async function createCheckpointCheckout(
  sandbox: Sandbox,
  input: { id: string; baseCommit: string; policy: CommandPolicy },
): Promise<SandboxHandle> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const id = attempt === 0 ? input.id : `${input.id}-r${attempt}`;
    try {
      return await sandbox.create({ id, baseCommit: input.baseCommit, policy: input.policy });
    } catch (err) {
      lastError = err;
      if (err instanceof PolishError && err.code === "CONFLICT") continue;
      break;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new PolishError(
    "SANDBOX_ERROR",
    `checkpoint checkout failed: ${message}`,
    { id: input.id, baseCommit: input.baseCommit },
    lastError instanceof Error ? { cause: lastError } : undefined,
  );
}

export async function destroyCheckout(handle: SandboxHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  await handle.destroy().catch(() => undefined);
}

export class CheckpointCheckoutEvidenceWorker implements FindingEvidenceWorker {
  constructor(
    private readonly options: {
      sandbox: Sandbox;
      policy: CommandPolicy;
      projectPath: string;
      persistOutput: ProjectEvidenceWorkerOptions["persistOutput"];
      now: () => number;
      nextId: () => string;
    },
  ) {}

  async reproduce(finding: Finding): Promise<EvidenceAttempt> {
    let handle: SandboxHandle | undefined;
    try {
      handle = await createCheckpointCheckout(this.options.sandbox, {
        id: this.options.nextId(),
        baseCommit: finding.checkpointHash,
        policy: this.options.policy,
      });
      await assertIsolatedCheckout(handle, this.options.projectPath, finding.checkpointHash);
    } catch (err) {
      return {
        method: "investigation",
        verdict: "UNCERTAIN",
        rationale: `checkpoint checkout failed: ${err instanceof Error ? err.message : String(err)}`,
        evidenceRefs: [],
      };
    }
    try {
      const worker = new ProjectFindingEvidenceWorker({
        projectPath: handle.path,
        persistOutput: this.options.persistOutput,
        now: this.options.now,
      });
      return await worker.reproduce(finding);
    } finally {
      await destroyCheckout(handle);
    }
  }
}
