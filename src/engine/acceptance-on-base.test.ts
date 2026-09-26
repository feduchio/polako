import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandPolicy } from "../sandbox/allowlist.js";
import type { ProcessResult } from "../sandbox/process.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import { acceptanceOnBase } from "./candidates.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function checkout(exitCodes: Record<string, number>): { handle: SandboxHandle; ran: string[][] } {
  const path = mkdtempSync(join(tmpdir(), "polish-acceptance-base-"));
  dirs.push(path);
  mkdirSync(join(path, "tests"));
  writeFileSync(join(path, "tests", "add.test.mjs"), "");
  const ran: string[][] = [];
  const run = (argv: readonly string[]): Promise<ProcessResult> => {
    ran.push([...argv]);
    return Promise.resolve({
      argv: [...argv], cwd: path, exitCode: exitCodes[argv.join(" ")] ?? 0, signal: null, stdout: "", stderr: "",
      truncated: false, timedOut: false, aborted: false, durationMs: 1, startedAt: 0,
    });
  };
  return { handle: { path, run } as unknown as SandboxHandle, ran };
}

const policy = CommandPolicy.forProject([["npm", "run", "test"]], "npm", false, { testFileArgv: ["node", "--test"] });

describe("acceptanceOnBase", () => {
  it("refuses a no-change claim when an acceptance line names a file the base lacks", async () => {
    const { handle } = checkout({});
    expect(await acceptanceOnBase({ acceptance: ["tests/neg.test.mjs asserts add(-1, 1) === 0"] }, handle, policy, undefined))
      .toMatch(/names tests\/neg\.test\.mjs, which is absent on the unchanged base/);
    expect(await acceptanceOnBase({ acceptance: ["tests/add.test.mjs passes", "npm run test passes"] }, handle, policy, undefined)).toBeNull();
  });

  it("runs the planner's structured checks on the base", async () => {
    const { handle, ran } = checkout({ "npm run test": 1 });
    expect(await acceptanceOnBase({ acceptance: ["it works"], acceptanceChecks: [{ kind: "test_file", path: "tests/add.test.mjs" }] }, handle, policy, undefined))
      .toBeNull();
    expect(ran).toEqual([["node", "--test", "tests/add.test.mjs"]]);
    expect(await acceptanceOnBase({ acceptance: ["it works"], acceptanceChecks: [{ kind: "command", argv: ["npm", "run", "test"] }] }, handle, policy, undefined))
      .toMatch(/`npm run test` exits 1 on the unchanged base/);
    expect(await acceptanceOnBase({ acceptance: ["it works"], acceptanceChecks: [{ kind: "file_exists", path: "docs/x.md" }] }, handle, policy, undefined))
      .toMatch(/file_exists docs\/x\.md: absent/);
    expect(await acceptanceOnBase({ acceptance: ["it works"], acceptanceChecks: [{ kind: "command", argv: ["rm", "-rf", "."] }] }, handle, policy, undefined))
      .toMatch(/refused by the command policy/);
  });
});
