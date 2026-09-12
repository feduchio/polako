import type { Finding } from "../domain/finding.js";
import type { ProjectProfile } from "../project/profile.js";
import type { ProtocolRegistry } from "../protocols/loader.js";
import { composeForWorker } from "../protocols/composer.js";
import type { TaskProtocolName } from "../protocols/types.js";
import type { Task, TaskKind } from "../domain/task.js";
import { buildWorkerContextPack } from "./worker.js";

/**
 * A task kind is not a protocol name. Four of the five coincide and `investigation` does not, so
 * `registry.get(task.kind)` throws on investigation tasks. Exhaustive by construction: a new task
 * kind cannot compile without a protocol.
 */
export const TASK_KIND_PROTOCOL = {
  bugfix: "bugfix",
  feature: "feature",
  refactor: "refactor",
  simplify: "simplify",
  investigation: "investigate",
} as const satisfies Record<TaskKind, TaskProtocolName>;

/**
 * The pack is resent on every turn, so its size is paid `pack x turns` and it displaces worker
 * turns rather than overrunning the task budget. Derived from the budget rather than fixed:
 * a constant is either too small for a verbose planner's task block — which is protected, so the
 * build throws — or large enough to eat the turns the worker needs.
 */
export function workerPackCap(effectiveTaskBudget: number, ceiling: number): number {
  return Math.min(Math.max(Math.floor(effectiveTaskBudget / 24), 1_000), ceiling);
}

export interface ComposeWorkerInstructionInput {
  registry: ProtocolRegistry;
  task: Task;
  findings: readonly Finding[];
  profile: ProjectProfile | null;
  tools: readonly string[];
  maxPackTokens: number;
}

/**
 * The single seam between a task and the text a production worker receives.
 *
 * `createWorkerFactory` wires this as `AgentRunnerDeps.prompt`; nothing else assembles worker
 * instruction text. Item 18 rebinds this seam rather than unpicking a concatenation.
 */
export function composeWorkerInstruction(
  input: ComposeWorkerInstructionInput,
): { text: string; protocolHash: string | null } {
  // No domains. `ProjectProfile` carries a test-runner hint (`vitest | jest | node-test |
  // unknown`), not a stack signal, so nothing in it can select `typescript` or `react-native`.
  // Selecting a domain would need a discovery signal this contract does not add; recorded as a
  // finding rather than guessed at here.
  const protocol = composeForWorker(input.registry, { task: TASK_KIND_PROTOCOL[input.task.kind] });

  const pack = buildWorkerContextPack({
    task: input.task,
    protocol,
    ...(input.profile === null ? {} : { profile: input.profile }),
    facts: [],
    findings: input.findings,
    fileFragments: [],
    failedAttempts: [],
    attemptNumber: input.task.attempts,
    tools: input.tools,
    maxPackTokens: input.maxPackTokens,
  });

  return { text: pack.text, protocolHash: pack.protocolHash };
}
