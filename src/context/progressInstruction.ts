import type { TaskKind } from "../domain/task.js";
import { compose } from "../protocols/composer.js";
import type { ProtocolRegistry } from "../protocols/loader.js";
import { TASK_KIND_PROTOCOL } from "./workerInstruction.js";

export function progressSystemPrompt(
  protocols: ProtocolRegistry,
  kind: TaskKind,
): string {
  const bundle = compose(protocols, {
    task: TASK_KIND_PROTOCOL[kind],
    role: "judge",
  });
  return [
    bundle.promptText,
    "Judge only the observed trajectory prefix. Future steps do not exist.",
    "Progress means the current files and observed verification would satisfy the task.",
    "Return only {\"progress\":0..4}; 0 means certainly no progress toward a valid solution.",
  ].join("\n\n");
}
