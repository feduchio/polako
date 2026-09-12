import { hashJson } from "../shared/hash.js";
import { PolishError } from "../shared/errors.js";
import type { ProtocolRegistry } from "./loader.js";
import {
  BASE_PROTOCOL_NAME,
  type ComposeInput,
  type ProtocolBundle,
  type TaskProtocolName,
  type ProtocolBundleMember,
} from "./types.js";

function toMember(p: ReturnType<ProtocolRegistry["get"]>): ProtocolBundleMember {
  return {
    name: p.meta.name,
    kind: p.meta.kind,
    body: p.body,
    resources: [...p.meta.resources],
    budgetTokens: p.meta.budget_tokens,
    dir: p.dir,
  };
}

function buildPrompt(members: ProtocolBundleMember[]): string {
  return members
    .map((m) => `## Protocol: ${m.name}\n\n${m.body.trim()}`)
    .join("\n\n---\n\n");
}

function bundleHash(members: ProtocolBundleMember[]): string {
  return hashJson(
    members.map((m) => ({
      name: m.name,
      kind: m.kind,
      body: m.body,
      resources: m.resources,
    })),
  );
}

function wrap(members: ProtocolBundleMember[]): ProtocolBundle {
  return {
    members,
    promptText: buildPrompt(members),
    hash: bundleHash(members),
    totalBudgetTokens: members.reduce((sum, m) => sum + m.budgetTokens, 0),
  };
}

/**
 * Deterministic protocol composition: base → task → domains (lexicographic) → role.
 */
export function compose(registry: ProtocolRegistry, input: ComposeInput): ProtocolBundle {
  const base = registry.get(BASE_PROTOCOL_NAME);
  if (base.meta.kind !== "base") {
    throw new PolishError("INVARIANT_VIOLATION", `${BASE_PROTOCOL_NAME} must have kind base`);
  }
  const task = registry.get(input.task);
  if (task.meta.kind !== "task") {
    throw new PolishError("INVARIANT_VIOLATION", `${input.task} must have kind task`);
  }
  const domains = [...(input.domains ?? [])].sort((a, b) => a.localeCompare(b));
  const domainMembers = domains.map((name) => {
    const d = registry.get(name);
    if (d.meta.kind !== "domain") {
      throw new PolishError("INVARIANT_VIOLATION", `${name} must have kind domain`);
    }
    return d;
  });
  const role = registry.get(input.role);
  if (role.meta.kind !== "role") {
    throw new PolishError("INVARIANT_VIOLATION", `${input.role} must have kind role`);
  }

  const members = [base, task, ...domainMembers, role].map(toMember);
  return wrap(members);
}

/**
 * Worker composition: base -> task -> domains (lexicographic), with **no role**.
 *
 * `compose` cannot serve a worker. It requires a role and validates `kind: role`, and none of the
 * role protocols in the tree applies to a worker; passing an unrelated role as a stand-in would
 * hand the worker a system prompt for someone else's job.
 */
export function composeForWorker(
  registry: ProtocolRegistry,
  input: { task: TaskProtocolName; domains?: readonly string[] },
): ProtocolBundle {
  const base = registry.get(BASE_PROTOCOL_NAME);
  if (base.meta.kind !== "base") {
    throw new PolishError("INVARIANT_VIOLATION", `${BASE_PROTOCOL_NAME} must have kind base`);
  }
  const task = registry.get(input.task);
  if (task.meta.kind !== "task") {
    throw new PolishError("INVARIANT_VIOLATION", `${input.task} must have kind task`);
  }
  const domainMembers = [...(input.domains ?? [])]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const d = registry.get(name);
      if (d.meta.kind !== "domain") {
        throw new PolishError("INVARIANT_VIOLATION", `${name} must have kind domain`);
      }
      return d;
    });
  return wrap([base, task, ...domainMembers].map(toMember));
}

/**
 * Drop trailing members (never the base) until the sum of `budget_tokens` fits.
 */
export function fitToBudget(bundle: ProtocolBundle, maxTokens: number): ProtocolBundle {
  if (maxTokens < 1) throw new PolishError("INVALID_ARGUMENT", "maxTokens must be positive");
  const members = [...bundle.members];
  if (members.length === 0) {
    throw new PolishError("INVARIANT_VIOLATION", "empty protocol bundle");
  }
  while (members.reduce((s, m) => s + m.budgetTokens, 0) > maxTokens) {
    if (members.length <= 1) {
      const alone = members[0];
      const need = alone === undefined ? 0 : alone.budgetTokens;
      throw new PolishError(
        "BUDGET_EXCEEDED",
        `base protocol alone requires ${need} tokens > max ${maxTokens}`,
      );
    }
    // Never drop base (index 0); drop from the end (role first, then domains, then task).
    members.pop();
  }
  return wrap(members);
}
