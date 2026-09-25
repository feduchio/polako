import { SYSTEM_ACTOR } from "../domain/common.js";
import { assertTransition } from "../domain/fsm.js";
import { TASK_TABLE, type Task } from "../domain/task.js";
import type { Clock } from "../shared/clock.js";
import { PolishError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import type { Store } from "../store/index.js";

/**
 * The only way a task changes state. Re-reads the projected task inside the append transaction,
 * so a writer holding a stale GATED cannot append it after BLOCKED, and attempts cannot go backwards.
 */
export function transitionTask(
  store: Store,
  clock: Clock,
  runId: string,
  next: Task,
  causedBy: string[] = [],
): Task {
  return store.transaction(() => {
    const current = store.repos.tasks.get(next.id);
    if (current === null) throw new PolishError("NOT_FOUND", `task ${next.id} not found`);
    if (next.attempts < current.attempts) {
      throw new PolishError(
        "CONFLICT",
        `task ${next.id} attempts would regress from ${String(current.attempts)} to ${String(next.attempts)}`,
      );
    }
    if (next.state !== current.state) {
      assertTransition(TASK_TABLE, `task ${next.id}`, current.state, next.state);
    }
    store.events.append([{
      id: id("evt", clock.now()),
      runId,
      ts: clock.now(),
      type: "task.state_changed",
      payload: { task: next },
      causedBy,
      actor: SYSTEM_ACTOR,
      artifacts: [],
    }]);
    return next;
  });
}
