import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PolishError } from "../shared/errors.js";
import { compose, fitToBudget } from "./composer.js";
import { defaultProtocolsRoot, ProtocolRegistry } from "./loader.js";

function writeSkill(
  root: string,
  name: string,
  fields: {
    kind: string;
    applies_to: string[];
    budget_tokens: number;
    resources?: string[];
    body?: string;
    description?: string;
  },
): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const resources = fields.resources ?? [];
  const resourcesYaml =
    resources.length === 0 ? "resources: []" : `resources:\n${resources.map((r) => `  - ${r}`).join("\n")}`;
  const applies = fields.applies_to.map((a) => `  - ${a}`).join("\n");
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${fields.description ?? `${name} protocol for tests`}
applies_to:
${applies}
kind: ${fields.kind}
budget_tokens: ${fields.budget_tokens}
${resourcesYaml}
---

# ${name}

${fields.body ?? "body"}
`,
    "utf8",
  );
}

describe("ProtocolRegistry", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("loads the repo protocol set including required names", () => {
    const registry = ProtocolRegistry.load(defaultProtocolsRoot());
    const names = registry.list().map((p) => p.meta.name);
    for (const required of [
      "base-engineering-policy",
      "bugfix",
      "feature",
      "refactor",
      "simplify",
      "investigate",
      "typescript",
      "react-native",
      "reviewer-correctness",
      "reviewer-regression",
      "reviewer-adversarial",
      "reviewer-architecture",
      "reviewer-simplicity",
      "evidence-agent",
      "defender",
      "prosecutor",
      "scope-guardian",
      "planner",
      "judge",
    ]) {
      expect(names).toContain(required);
    }
    expect(registry.get("base-engineering-policy").meta.kind).toBe("base");
  });

  it("rejects name/directory mismatch", () => {
    dir = mkdtempSync(join(tmpdir(), "polish-proto-"));
    writeSkill(dir, "bugfix", { kind: "task", applies_to: ["worker"], budget_tokens: 10 });
    writeFileSync(
      join(dir, "bugfix", "SKILL.md"),
      `---
name: feature
description: wrong
applies_to:
  - worker
kind: task
budget_tokens: 10
resources: []
---

x
`,
    );
    expect(() => ProtocolRegistry.load(dir)).toThrow(PolishError);
  });

  it("rejects empty SKILL.md body", () => {
    dir = mkdtempSync(join(tmpdir(), "polish-proto-"));
    mkdirSync(join(dir, "empty-body"), { recursive: true });
    writeFileSync(
      join(dir, "empty-body", "SKILL.md"),
      `---
name: empty-body
description: has frontmatter only
applies_to:
  - worker
kind: task
budget_tokens: 10
resources: []
---
`,
    );
    expect(() => ProtocolRegistry.load(dir)).toThrow(PolishError);
  });

  it("composes deterministically and hashes stably", () => {
    const registry = ProtocolRegistry.load(defaultProtocolsRoot());
    const a = compose(registry, { task: "bugfix", domains: ["react-native", "typescript"], role: "planner" });
    const b = compose(registry, { task: "bugfix", domains: ["typescript", "react-native"], role: "planner" });
    expect(a.members.map((m) => m.name)).toEqual([
      "base-engineering-policy",
      "bugfix",
      "react-native",
      "typescript",
      "planner",
    ]);
    expect(a.hash).toBe(b.hash);
    expect(a.promptText).toContain("## Protocol: base-engineering-policy");
    expect(a.promptText).not.toContain("Anti-rationalization");
    expect(a.totalBudgetTokens).toBeGreaterThan(a.members[0]!.budgetTokens);
  });

  it("fitToBudget drops trailing members but never base", () => {
    const registry = ProtocolRegistry.load(defaultProtocolsRoot());
    const full = compose(registry, { task: "feature", domains: ["typescript"], role: "judge" });
    const baseOnly = fitToBudget(full, full.members[0]!.budgetTokens);
    expect(baseOnly.members.map((m) => m.name)).toEqual(["base-engineering-policy"]);
    expect(() => fitToBudget(full, full.members[0]!.budgetTokens - 1)).toThrow(PolishError);
  });

  it("readResource allows listed files and blocks escape / unlisted", () => {
    const registry = ProtocolRegistry.load(defaultProtocolsRoot());
    const text = registry.readResource("base-engineering-policy", "references/anti-rationalization.md");
    expect(text).toContain("Forbidden excuses");
    expect(() => registry.readResource("base-engineering-policy", "SKILL.md")).toThrow(PolishError);
    expect(() => registry.readResource("base-engineering-policy", "../bugfix/SKILL.md")).toThrow(PolishError);

    dir = mkdtempSync(join(tmpdir(), "polish-proto-"));
    writeSkill(dir, "base-engineering-policy", {
      kind: "base",
      applies_to: ["worker"],
      budget_tokens: 10,
      resources: ["notes.md", "evil.md"],
    });
    writeSkill(dir, "bugfix", { kind: "task", applies_to: ["worker"], budget_tokens: 10 });
    writeFileSync(join(dir, "base-engineering-policy", "notes.md"), "ok\n");
    symlinkSync(join(dir, "bugfix", "SKILL.md"), join(dir, "base-engineering-policy", "evil.md"));
    const reg = ProtocolRegistry.load(dir);
    expect(reg.readResource("base-engineering-policy", "notes.md")).toBe("ok\n");
    expect(() => reg.readResource("base-engineering-policy", "evil.md")).toThrow(PolishError);
  });
});
