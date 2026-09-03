import type { RuntimeCapabilityClass } from "../domain/acceptance.js";
import { RuntimeUnavailableError } from "./types.js";
import type { RuntimeCapabilityMode, RuntimeScenario, RuntimeSelection, RuntimeValidator } from "./types.js";

/**
 * Resolve a validator according to auto/required/off without executing a scenario.
 * `auto` uses only AVAILABLE_SAFE validators. `required` fails closed when none are usable.
 */
export async function discoverRuntimeValidator(
  mode: RuntimeCapabilityMode,
  scenario: RuntimeScenario,
  validators: readonly RuntimeValidator[],
  signal?: AbortSignal,
): Promise<RuntimeSelection> {
  if (mode === "off") {
    return { mode, capability: "NOT_APPLICABLE", validator: null, reason: "runtime validation disabled" };
  }
  const reasons: string[] = [];
  let sawUnsafe = false;
  for (const validator of validators) {
    if (!validator.supports(scenario)) {
      reasons.push(`${validator.id}: unsupported scenario kind ${scenario.kind}`);
      continue;
    }
    try {
      const availability = await validator.availability(scenario, signal);
      if (availability.available && availability.capability === "AVAILABLE_SAFE") {
        return { mode, capability: "AVAILABLE_SAFE", validator, reason: `${validator.id} available` };
      }
      if (availability.capability === "AVAILABLE_UNSAFE") sawUnsafe = true;
      reasons.push(`${validator.id}: ${availability.reason ?? availability.capability}`);
    } catch (error) {
      reasons.push(`${validator.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const capability: RuntimeCapabilityClass = sawUnsafe ? "AVAILABLE_UNSAFE" : reasons.length > 0 ? "UNAVAILABLE" : "NOT_APPLICABLE";
  const reason = reasons.length > 0 ? reasons.join("; ") : "no runtime validators configured";
  if (mode === "required") throw new RuntimeUnavailableError([reason]);
  return { mode, capability, validator: null, reason };
}
