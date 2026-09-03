import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git } from "../sandbox/git.js";
import { applyRunBranch } from "./apply.js";

describe("apply semantics", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the user branch unchanged until explicit apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-apply-"));
    dirs.push(dir);
    const git = await Git.init(dir);
    writeFileSync(join(dir, "value.txt"), "before\n");
    const baseline = await git.commitAll("baseline");
    expect(baseline).not.toBeNull();

    await git.run(["switch", "-q", "-c", "polish/run-test"]);
    writeFileSync(join(dir, "value.txt"), "after\n");
    const runCommit = await git.commitAll("run result");
    expect(runCommit).not.toBeNull();
    await git.run(["switch", "-q", "main"]);

    expect(await git.revParse("main")).toBe(baseline);
    expect(await git.revParse("polish/run-test")).toBe(runCommit);

    const applied = await applyRunBranch({
      projectPath: dir,
      runBranch: "polish/run-test",
      expectedTargetBranch: "main",
    });

    expect(applied).toEqual({ branch: "main", commit: runCommit });
    expect(await git.revParse("main")).toBe(runCommit);
  });

  it("refuses to apply over a dirty checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-apply-"));
    dirs.push(dir);
    const git = await Git.init(dir);
    writeFileSync(join(dir, "value.txt"), "before\n");
    await git.commitAll("baseline");
    await git.createBranch("polish/run-test", "HEAD");
    writeFileSync(join(dir, "value.txt"), "dirty\n");

    await expect(applyRunBranch({
      projectPath: dir,
      runBranch: "polish/run-test",
      expectedTargetBranch: "main",
    })).rejects.toThrow("uncommitted changes");
  });

  it("refuses non-fast-forward apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-apply-"));
    dirs.push(dir);
    const git = await Git.init(dir);
    writeFileSync(join(dir, "value.txt"), "base\n");
    const baseline = await git.commitAll("baseline");
    await git.createBranch("polish/run-test", "HEAD");
    writeFileSync(join(dir, "value.txt"), "run\n");
    const runCommit = await git.commitAll("run");
    await git.run(["switch", "-q", "main"]);
    writeFileSync(join(dir, "value.txt"), "diverged\n");
    await git.commitAll("diverged");

    await expect(applyRunBranch({
      projectPath: dir,
      runBranch: "polish/run-test",
      expectedTargetBranch: "main",
    })).rejects.toThrow("cannot fast-forward");
    expect(await git.revParse("main")).not.toBe(runCommit);
    expect(baseline).not.toBeNull();
  });
});
