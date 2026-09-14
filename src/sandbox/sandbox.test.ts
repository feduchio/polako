import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../domain/config.js";
import { CommandPolicy } from "./allowlist.js";
import { scrubEnv, suspiciousEnvNames } from "./env.js";
import { Git } from "./git.js";
import { compressOutput, renderCompressed } from "./outputCompressor.js";
import { runProcess } from "./process.js";
import { WorktreeSandbox } from "./worktree.js";

const cfg = defaultConfig().sandbox;

describe("scrubEnv", () => {
  it("keeps only allowlisted names, drops secret-looking ones even if allowlisted, and applies fixed vars", () => {
    const env = scrubEnv(
      { PATH: "/bin", HOME: "/h", OPENROUTER_API_KEY: "sk-x", GH_TOKEN: "t", RANDOM_VAR: "1", MY_SECRET_THING: "s" },
      { allowlist: ["PATH", "HOME", "OPENROUTER_API_KEY", "MY_SECRET_THING"], denyPatterns: cfg.envDenyPatterns },
      { EXTRA: "yes", AWS_SECRET_ACCESS_KEY: "nope" },
    );
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", EXTRA: "yes", CI: "1", NO_COLOR: "1" });
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("RANDOM_VAR");
    expect(env).not.toHaveProperty("MY_SECRET_THING");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  it("lists suspicious names for doctor", () => {
    expect(suspiciousEnvNames({ PATH: "x", GEMINI_API_KEY: "y", npm_config_token: "z" }, cfg.envDenyPatterns)).toEqual([
      "GEMINI_API_KEY",
      "npm_config_token",
    ]);
  });
});

describe("runProcess", () => {
  it("captures output and exit code without a shell", async () => {
    const r = await runProcess({ argv: ["node", "-e", "console.log('hi $HOME'); process.exit(3)"], cwd: tmpdir(), env: { PATH: process.env["PATH"]! }, timeoutMs: 10_000, maxOutputBytes: 1024 });
    expect(r.exitCode).toBe(3);
    expect(r.stdout.trim()).toBe("hi $HOME");
    expect(r.truncated).toBe(false);
  });

  it("caps output and flags truncation", async () => {
    const r = await runProcess({ argv: ["node", "-e", "process.stdout.write('x'.repeat(10000))"], cwd: tmpdir(), env: { PATH: process.env["PATH"]! }, timeoutMs: 10_000, maxOutputBytes: 100 });
    expect(r.stdout.length).toBe(100);
    expect(r.truncated).toBe(true);
  });

  it("kills the whole process group on timeout", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "polish-proc-"));
    const marker = join(markerDir, "child.pid");
    const script = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const c = spawn('sleep', ['30'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(marker)}, String(c.pid));
      setTimeout(() => {}, 30000);
    `;
    const started = Date.now();
    const r = await runProcess({ argv: ["node", "-e", script], cwd: tmpdir(), env: { PATH: process.env["PATH"]! }, timeoutMs: 500, maxOutputBytes: 1024 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    await new Promise((res) => setTimeout(res, 200));
    const childPid = Number((await import("node:fs")).readFileSync(marker, "utf8"));
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    rmSync(markerDir, { recursive: true, force: true });
  });

  it("aborts via signal", async () => {
    const ac = new AbortController();
    const p = runProcess({ argv: ["sleep", "30"], cwd: tmpdir(), env: { PATH: process.env["PATH"]! }, timeoutMs: 30_000, maxOutputBytes: 1024, signal: ac.signal });
    setTimeout(() => {
      ac.abort();
    }, 100);
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
  });

  it("rejects on spawn failure", async () => {
    await expect(runProcess({ argv: ["definitely-not-a-binary-xyz"], cwd: tmpdir(), env: {}, timeoutMs: 1000, maxOutputBytes: 10 })).rejects.toThrow(/failed to spawn/);
  });

  it("does not crash on stdin EPIPE when the child ignores stdin", async () => {
    const r = await runProcess({
      argv: ["node", "-e", "process.exit(0)"],
      cwd: tmpdir(),
      env: { PATH: process.env["PATH"]! },
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      stdin: "x".repeat(256 * 1024),
    });
    expect(r.exitCode).toBe(0);
  });
});

describe("CommandPolicy", () => {
  const policy = CommandPolicy.forProject([["pnpm", "test"], ["pnpm", "typecheck"]], "pnpm");

  it("admits exactly the install command of the discovered package manager, and nothing near it", () => {
    // A project with no installed dependencies cannot produce evidence about itself (finding 54),
    // and the command that fixes that has to be nameable by the policy that admits it.
    expect(policy.check(["pnpm", "install", "--frozen-lockfile"])).toBeNull();
    // Exact, not prefix: an appended argument is a different command.
    expect(policy.check(["pnpm", "install", "--frozen-lockfile", "--force"])).toMatch(/not in allowlist/);
    expect(policy.check(["pnpm", "install"])).toMatch(/not in allowlist/);
    expect(policy.check(["pnpm", "--frozen-lockfile", "install"])).toMatch(/not in allowlist/);
    // Another package manager's install is not admitted by a pnpm project.
    expect(policy.check(["npm", "ci"])).toMatch(/not in allowlist/);
    expect(CommandPolicy.forProject([], "npm").check(["npm", "ci"])).toBeNull();
    expect(CommandPolicy.forProject([], "npm").check(["pnpm", "install", "--frozen-lockfile"])).toMatch(/not in allowlist/);
    // A package manager we do not drive gains no install rule at all.
    expect(CommandPolicy.forProject([], "cargo").check(["cargo", "build"])).toMatch(/not in allowlist/);
  });

  it("allows project checks and read-only git; denies raw search and the rest", () => {
    expect(policy.check(["pnpm", "test"])).toBeNull();
    expect(policy.check(["pnpm", "test", "--", "src/x.test.ts"])).toMatch(/not in allowlist/);
    expect(policy.check(["git", "diff", "HEAD~1"])).toBeNull();
    expect(policy.check(["rg", "foo|bar", "src"])).toMatch(/not in allowlist/);
    expect(policy.check(["cat", "package.json"])).toMatch(/not in allowlist/);
    expect(policy.check(["head", "-n", "1", "package.json"])).toMatch(/not in allowlist/);
    expect(policy.check(["ls", "src"])).toMatch(/not in allowlist/);
    expect(policy.check(["rg", "--pre", "sh -c id", "needle"])).toMatch(/option not allowed/);
    expect(policy.check(["find", ".", "-type", "f"])).toMatch(/not in allowlist/);
    expect(policy.check(["pnpm", "run", "arbitrary"])).toMatch(/not in allowlist/);
    expect(policy.check(["pnpm", "exec", "node", "-e", "process.exit()"])).toMatch(/not in allowlist/);
    expect(policy.check(["git", "push", "origin", "main"])).toMatch(/not.*allowlist|not read-only/);
    expect(policy.check(["rm", "-rf", "/"])).toMatch(/not in allowlist/);
    expect(policy.check(["curl", "http://x"])).toMatch(/not in allowlist/);
    expect(policy.check(["git", "show", "/etc/passwd"])).toMatch(/outside the worktree/);
  });

  it("grants search/read only when explicitly requested and confines operands", () => {
    const withSearch = CommandPolicy.forProject([["pnpm", "test"]], "pnpm", false, { search: true });
    expect(withSearch.check(["rg", "foo|bar", "src"])).toBeNull();
    expect(withSearch.check(["cat", "src/a.ts"])).toBeNull();
    expect(withSearch.check(["rg", "--pre", "sh -c id", "needle"])).toMatch(/option not allowed/);
    expect(withSearch.check(["cat", "/etc/passwd"])).toMatch(/outside the worktree/);
    expect(withSearch.check(["rg", "foo", "../secret"])).toMatch(/outside the worktree/);
    expect(withSearch.check(["head", "-n", "2", "~/secrets"])).toMatch(/outside the worktree/);
  });

  it("allows only named package scripts and explicit task grants", () => {
    const scoped = CommandPolicy.forProject([], "pnpm", false, {
      packageScripts: ["test"],
      taskGrants: [{ prefix: ["node", "tools/audit.mjs"], description: "task audit" }],
    });
    expect(scoped.check(["pnpm", "run", "test"])).toBeNull();
    expect(scoped.check(["pnpm", "run", "test", "--", "src/x.test.ts"])).toMatch(/not in allowlist/);
    expect(scoped.check(["pnpm", "run", "test", "--config", "evil.config.ts"])).toMatch(/not in allowlist/);
    expect(scoped.check(["pnpm", "run", "evil"])).toMatch(/not in allowlist/);
    expect(scoped.check(["pnpm", "exec", "vitest"])).toMatch(/not in allowlist/);
    expect(scoped.check(["node", "tools/audit.mjs", "--json"])).toBeNull();
    expect(scoped.check(["node", "tools/other.mjs"])).toMatch(/not in allowlist/);
    const trailing = CommandPolicy.forProject([], "pnpm", false, {
      packageScripts: ["test"],
      packageScriptsAllowTrailingArgs: ["test"],
    });
    expect(trailing.check(["pnpm", "run", "test", "--", "src/x.test.ts"])).toBeNull();
    expect(trailing.check(["pnpm", "run", "test", "--config", "x.ts"])).toBeNull();
  });

  it("rejects empty command and task-grant prefixes", () => {
    expect(() => new CommandPolicy([{ prefix: [], description: "vacuous" }])).toThrow(/non-empty/);
    expect(() => CommandPolicy.forProject([], null, false, {
      taskGrants: [{ prefix: [], description: "vacuous task grant" }],
    })).toThrow(/non-empty/);
  });

  it("never allows shell -c or shell operators, even in arbitrary mode", () => {
    const arbitrary = CommandPolicy.forProject([], "pnpm", true);
    expect(arbitrary.check(["sh", "-c", "echo hi"])).toMatch(/shell -c/);
    expect(arbitrary.check(["bash", "-lc", "echo hi"])).toMatch(/shell -c/);
    expect(arbitrary.check(["/bin/bash", "-c", "echo hi"])).toMatch(/shell -c/);
    expect(arbitrary.check(["BASH", "-c", "echo hi"])).toMatch(/shell -c/);
    expect(arbitrary.check(["/usr/bin/env", "bash", "-c", "echo hi"])).toMatch(/shell -c/);
    expect(arbitrary.check(["env", "-i", "bash", "-c", "echo hi"])).toMatch(/shell -c/);
    expect(arbitrary.check(["nice", "bash", "-c", "echo hi"])).toMatch(/shell -c/);
    const strict = CommandPolicy.forProject([["pnpm", "test"]], "pnpm");
    expect(strict.check(["pnpm", "exec", "bash", "-lc", "echo hi"])).toMatch(/shell -c/);
    expect(strict.check(["find", ".", "-exec", "bash", "-c", "echo pwned", "{}", "+"])).toMatch(/shell -c/);
    expect(strict.check(["find", ".", "-execdir", "zsh", "-c", "echo pwned", "{}", "+"])).toMatch(/shell -c/);
    expect(strict.check(["git", "grep", "--open-files-in-pager=sh -c \"echo pwned\"", "-e", "one"])).toMatch(/pager|shell -c/);
    expect(strict.check(["git", "grep", "-Osh -c \"echo pwned\"", "-e", "one"])).toMatch(/pager|shell -c/);
    expect(strict.check(["git", "grep", "-O", "sh", "-c", "echo pwned", "-e", "one"])).toMatch(/pager|shell -c/);
    expect(strict.check(["git", "grep", "--open-files-in-pager=touch /tmp/PWNED", "-e", "one"])).toMatch(/pager|not in allowlist/);
    expect(strict.check(["git", "grep", "--open-files-in-pager=sh${IFS}-c${IFS}id", "-e", "one"])).toMatch(/pager|not in allowlist/);
    expect(strict.check(["git", "grep", "-O touch /tmp/PWNED", "-e", "one"])).toMatch(/pager|not in allowlist/);
    expect(strict.check(["git", "grep", "--open=touch /tmp/PWNED", "-e", "one"])).toMatch(/pager|not in allowlist/);
    expect(strict.check(["git", "grep", "--open-files=touch /tmp/PWNED", "-e", "one"])).toMatch(/pager|not in allowlist/);
    expect(strict.check(["git", "grep", "-iOtouch /tmp/PWNED", "-e", "one"])).toMatch(/pager|not in allowlist/);
    expect(strict.check(["git", "grep", "-inOtouch /tmp/PWNED", "-e", "one"])).toMatch(/pager|not in allowlist/);
    expect(arbitrary.check(["git", "grep", "-iOtouch /tmp/PWNED", "-e", "one"])).toMatch(/pager/);
    expect(arbitrary.check(["git", "grep", "-IOsh -c \"echo x\"", "-e", "one"])).toMatch(/pager/);
    expect(arbitrary.check(["git", "grep", "-WOsh -c \"echo x\"", "-e", "one"])).toMatch(/pager/);
    expect(strict.check(["git", "log", "--oneline"])).toBeNull();
    expect(strict.check(["git", "diff", "-Oorderfile"])).toMatch(/pager/);
    expect(strict.check(["git", "log", "--", "-Ofile.txt"])).toBeNull();
    expect(strict.check(["git", "grep", "-e", "bash", "-i"])).toMatch(/not.*allowlist|not read-only/);
    expect(strict.check(["rg", "bash", "-i"])).toMatch(/not in allowlist/);
    expect(arbitrary.check(["rg", "sh -c"])).toBeNull();
    expect(arbitrary.check(["pnpm", "test", "&&", "git", "push"])).toMatch(/shell operators/);
    expect(arbitrary.check(["rg", "-c", "sh"])).toBeNull();
    expect(arbitrary.check(["rg", "sh", "-c"])).toBeNull();
    expect(arbitrary.check(["/usr/bin/rg", "sh", "-c"])).toBeNull();
    expect(strict.check(["pnpm", "exec", "rg", "sh", "-c"])).toMatch(/not in allowlist/);
    expect(arbitrary.check(["curl", "http://x"])).toBeNull();
  });
});

describe("WorktreeSandbox", () => {
  let repoDir: string;
  let root: string;
  let repo: Git;
  let base: string;
  let sandbox: WorktreeSandbox;

  beforeEach(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "polish-repo-"));
    root = mkdtempSync(join(tmpdir(), "polish-wt-"));
    repo = await Git.init(repoDir);
    writeFileSync(join(repoDir, "a.txt"), "one\ntwo\nthree\n");
    base = (await repo.commitAll("init"))!;
    sandbox = new WorktreeSandbox(repoDir, root, cfg);
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("creates an isolated worktree on its own branch, commits, diffs and destroys it", async () => {
    const policy = CommandPolicy.forProject([], null);
    const h = await sandbox.create({ id: "cand1", baseCommit: base, branch: "polish/cand1", policy });
    expect(existsSync(join(h.path, "a.txt"))).toBe(true);
    writeFileSync(join(h.path, "b.txt"), "two\n");
    expect(await h.changedFiles()).toEqual(["b.txt"]);
    expect(await h.changedFiles(base)).toEqual(["b.txt"]);
    const commit = await h.commitAll("add b");
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await h.headCommit()).toBe(commit);
    expect(await h.diffStat()).toEqual({ files: 1, insertions: 1, deletions: 0 });
    expect(await h.diff()).toContain("+two");
    expect(await repo.revParse("main")).toBe(base);
    expect(existsSync(join(repoDir, "b.txt"))).toBe(false);
    expect(await sandbox.list()).toEqual([h.path]);

    await h.destroy();
    expect(existsSync(h.path)).toBe(false);
    expect(await sandbox.list()).toEqual([]);
    expect(await repo.branchExists("polish/cand1")).toBe(true);
  });

  it("includes untracked files in changedFiles(base)", async () => {
    const policy = CommandPolicy.forProject([], null);
    const h = await sandbox.create({ id: "untracked", baseCommit: base, policy });
    writeFileSync(join(h.path, "planted-protected.test.ts"), "untracked plant\n");
    expect(await h.changedFiles(base)).toEqual(["planted-protected.test.ts"]);
    expect(await h.git.diffAgainst(base)).toContain("+++ b/planted-protected.test.ts");
    expect(await h.git.diffAgainst(base)).toContain("+untracked plant");
    await h.destroy();
  });

  it("preserves add/delete status between commits", async () => {
    writeFileSync(join(repoDir, "a.test.ts"), "old test\n");
    const withTest = await repo.commitAll("add old test");
    expect(withTest).not.toBeNull();
    const policy = CommandPolicy.forProject([], null);
    const h = await sandbox.create({ id: "statuses", baseCommit: withTest!, policy });
    unlinkSync(join(h.path, "a.test.ts"));
    writeFileSync(join(h.path, "z.test.ts"), "test\n");
    const head = await h.commitAll("replace a file");
    expect(head).not.toBeNull();
    expect(await h.git.changedFileStatusesBetween(withTest!, head!)).toEqual([
      { status: "D", path: "a.test.ts" },
      { status: "A", path: "z.test.ts" },
    ]);
    expect(await h.git.showFile(head!, "z.test.ts")).toBe("test\n");
    await h.destroy();
  });

  it("reads committed blobs as exact bytes and rejects capped output", async () => {
    const bytes = Buffer.from([0xff, 0x00, 0x0a, 0x80]);
    writeFileSync(join(repoDir, "raw.test.bin"), bytes);
    const head = await repo.commitAll("add raw blob");
    expect(head).not.toBeNull();
    expect(Buffer.from(await repo.showFileBytes(head!, "raw.test.bin"))).toEqual(bytes);
    await expect(new Git(repoDir, 120_000, 3).showFileBytes(head!, "raw.test.bin"))
      .rejects.toThrow(/truncated/);
  });

  it("enforces the command policy and scrubs the environment for commands", async () => {
    process.env["POLISH_TEST_SECRET_TOKEN"] = "leak";
    const dumpEnv = "console.log(JSON.stringify(process.env))";
    const dumpAws = "console.log(JSON.stringify(process.env.AWS_SECRET_ACCESS_KEY))";
    const dumpCi = "console.log(process.env.CI)";
    const policy = CommandPolicy.forProject([
      ["node", "-e", dumpEnv],
      ["node", "-e", dumpAws],
      ["node", "-e", dumpCi],
    ], null);
    const h = await sandbox.create({ id: "c2", baseCommit: base, policy });
    try {
      await expect(h.run(["git", "push"])).rejects.toThrow(/not read-only allowlisted/);
      const r = await h.run(["node", "-e", dumpEnv]);
      const env = JSON.parse(r.stdout) as Record<string, string>;
      expect(env).not.toHaveProperty("POLISH_TEST_SECRET_TOKEN");
      expect(env["CI"]).toBe("1");
      expect(env["PATH"]).toBeDefined();

      const leaked = await h.run(["node", "-e", dumpAws], {
        env: { AWS_SECRET_ACCESS_KEY: "leaked-via-optsenv", CI: "0" },
      });
      expect(leaked.stdout.trim()).toBe("undefined");
      const ciProbe = await h.run(["node", "-e", dumpCi], { env: { CI: "0" } });
      expect(ciProbe.stdout.trim()).toBe("1");
    } finally {
      delete process.env["POLISH_TEST_SECRET_TOKEN"];
      await h.destroy();
    }
  });

  it("rejects sandbox ids that escape the root", async () => {
    const policy = CommandPolicy.forProject([], null);
    await expect(sandbox.create({ id: "../escaped", baseCommit: base, policy })).rejects.toThrow(/invalid sandbox id|escapes root/);
    await expect(sandbox.create({ id: "--detach", baseCommit: base, policy })).rejects.toThrow(/invalid sandbox id/);
    await expect(sandbox.create({ id: "ok", baseCommit: "--detach", policy })).rejects.toThrow(/invalid git commitish/);
  });

  it("rejects cwd values that escape the worktree", async () => {
    const policy = CommandPolicy.forProject([
      ["node", "-e", "process.exit(0)"],
      ["node", "-e", "console.log(process.cwd())"],
    ], null);
    const h = await sandbox.create({ id: "cwd-test", baseCommit: base, policy });
    await expect(h.run(["node", "-e", "process.exit(0)"], { cwd: "../.." })).rejects.toThrow(/cwd escapes/);
    const ok = await h.run(["node", "-e", "console.log(process.cwd())"], { cwd: "." });
    expect(ok.stdout.trim()).toBe(h.path);
    await h.destroy();
  });

  it("rejects symlink cwd that escapes the worktree", async () => {
    const policy = CommandPolicy.forProject([["node", "-e", "process.exit(0)"]], null);
    const victim = await sandbox.create({ id: "victim", baseCommit: base, policy });
    const attacker = await sandbox.create({ id: "attacker", baseCommit: base, policy });
    symlinkSync(victim.path, join(attacker.path, "peer"));
    await expect(attacker.run(["node", "-e", "process.exit(0)"], { cwd: "peer" })).rejects.toThrow(/cwd escapes/);
    await victim.destroy();
    await attacker.destroy();
  });

  it("exposes isolates=false and supports bypassPolicy, destroyAll, commitAll null, and fastForward", async () => {
    expect(sandbox.isolates).toBe(false);
    const policy = CommandPolicy.forProject([["node", "-e"]], null);
    const a = await sandbox.create({ id: "ff-a", baseCommit: base, branch: "polish/ff-a", policy });
    const b = await sandbox.create({ id: "ff-b", baseCommit: base, branch: "polish/ff-b", policy });
    expect(await sandbox.list()).toHaveLength(2);
    expect(await a.commitAll("noop")).toBeNull();
    writeFileSync(join(b.path, "b.txt"), "b\n");
    const tip = (await b.commitAll("add b"))!;
    expect(await repo.fastForward("polish/ff-a", tip)).toBe(true);
    expect(await repo.fastForward("polish/ff-a", base)).toBe(false);
    await expect(a.run(["git", "push"])).rejects.toThrow(/not read-only allowlisted/);
    const bypassed = await a.run(["node", "-e", "console.log('bypassed')"], { bypassPolicy: true });
    expect(bypassed.stdout.trim()).toBe("bypassed");
    await sandbox.destroyAll();
    expect(await sandbox.list()).toEqual([]);
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(false);
  });

  it("refuses duplicate ids and branches", async () => {
    const policy = CommandPolicy.forProject([], null);
    const h = await sandbox.create({ id: "dup", baseCommit: base, branch: "polish/dup", policy });
    await expect(sandbox.create({ id: "dup", baseCommit: base, policy })).rejects.toThrow(/already exists/);
    await expect(sandbox.create({ id: "dup2", baseCommit: base, branch: "polish/dup", policy })).rejects.toThrow(/branch already exists/);
    await h.destroy();
  });

  it("cherry-picks a candidate commit onto another checkout and reports conflicts", async () => {
    const policy = CommandPolicy.forProject([], null);
    const a = await sandbox.create({ id: "a", baseCommit: base, branch: "polish/a", policy });
    writeFileSync(join(a.path, "a.txt"), "from a\n");
    const ca = (await a.commitAll("a"))!;
    const b = await sandbox.create({ id: "b", baseCommit: base, branch: "polish/b", policy });
    writeFileSync(join(b.path, "a.txt"), "from b\n");
    await b.commitAll("b");
    const conflict = await b.git.cherryPick(ca);
    expect(conflict.ok).toBe(false);
    expect(conflict.conflicts).toEqual(["a.txt"]);
    expect(await b.git.isClean()).toBe(true);

    writeFileSync(join(b.path, "keep.txt"), "precious\n");
    const conflictWithWork = await b.git.cherryPick(ca);
    expect(conflictWithWork.ok).toBe(false);
    expect(readFileSync(join(b.path, "keep.txt"), "utf8")).toBe("precious\n");

    const pickSrc = await sandbox.create({ id: "pick-src", baseCommit: base, branch: "polish/pick-src", policy });
    writeFileSync(join(pickSrc.path, "a.txt"), "one\nPICKED\nthree\n");
    const pickCommit = (await pickSrc.commitAll("picked line"))!;
    const dirty = await sandbox.create({ id: "dirty", baseCommit: base, branch: "polish/dirty", policy });
    writeFileSync(join(dirty.path, "a.txt"), "one\nWORKER\nthree\n");
    const stashOverlap = await dirty.git.cherryPick(pickCommit);
    expect(stashOverlap.ok).toBe(false);
    expect(stashOverlap.conflicts).toContain("a.txt");
    expect(readFileSync(join(dirty.path, "a.txt"), "utf8")).toBe("one\nWORKER\nthree\n");
    expect(readFileSync(join(dirty.path, "a.txt"), "utf8")).not.toContain("<<<<<<<");
    expect(await dirty.git.out(["stash", "list"])).toBe("");
    const afterFail = (await dirty.commitAll("after failed stash pop"))!;
    expect((await dirty.git.out(["show", afterFail, "--", "a.txt"])).includes("<<<<<<<")).toBe(false);
    await pickSrc.destroy();
    await dirty.destroy();

    const c = await sandbox.create({ id: "c", baseCommit: base, branch: "polish/c", policy });
    writeFileSync(join(c.path, "c.txt"), "c\n");
    await c.commitAll("c");
    const ok = await c.git.cherryPick(ca);
    expect(ok.ok).toBe(true);
    expect(await c.git.out(["stash", "list"])).toBe("");
    expect(await c.commitAll("integrate a")).not.toBeNull();
    expect((await c.git.diff(base)).includes("from a")).toBe(true);
  });
});

describe("compressOutput", () => {
  it("surfaces error-like lines and keeps head/tail", () => {
    const lines = ["Progress: 1%", "starting", ...Array.from({ length: 100 }, (_, i) => `line ${i}`), "FAIL src/x.test.ts > does thing", "AssertionError: expected 1 to be 2", "Tests: 1 failed, 4 passed"];
    const c = compressOutput(lines.join("\n"), { headLines: 3, tailLines: 3 });
    expect(c.errorLines.some((l) => l.includes("AssertionError"))).toBe(true);
    expect(c.errorLines.some((l) => l.includes("FAIL src/x.test.ts"))).toBe(true);
    expect(c.head.split("\n")).toEqual(["starting", "line 0", "line 1"]);
    expect(c.tail.split("\n")).toHaveLength(3);
    const rendered = renderCompressed(c, 500);
    expect(rendered.length).toBeLessThanOrEqual(500);
    expect(rendered).toContain("error-like lines");
  });
});
