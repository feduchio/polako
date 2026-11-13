import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOnly, projectForCards, readBrief, resolveRunTarget } from "./cards.js";
import { runCli } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CARD = (id: string, depends = "") => `id: ${id}\ntitle: Title ${id}\ndepends: ${depends}\nfiles: src/${id}.ts\n\nDo ${id}.\n\nAccept: ${id} works.\n`;

function repoWithCards(): { repo: string; tasks: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "polako-cli-cards-")));
  dirs.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const tasks = join(repo, "docs", "tasks");
  mkdirSync(tasks, { recursive: true });
  writeFileSync(join(tasks, "N01-a.md"), CARD("N01"));
  writeFileSync(join(tasks, "N02-b.md"), CARD("N02", "N01"));
  return { repo, tasks };
}

describe("resolveRunTarget", () => {
  const looks = (spec: string): boolean => spec.endsWith(".md") || spec === "cards-dir";

  it("keeps `--mission` and `[project] [words]` runs as they were", () => {
    expect(resolveRunTarget([], undefined, "/w", looks)).toEqual({ project: null, cardSpecs: [], mission: "" });
    expect(resolveRunTarget(["/proj"], undefined, "/w", looks)).toEqual({ project: "/proj", cardSpecs: [], mission: "" });
    expect(resolveRunTarget(["/proj", "add", "dark", "mode"], undefined, "/w", looks)).toEqual({ project: "/proj", cardSpecs: [], mission: "add dark mode" });
    expect(resolveRunTarget(["/proj"], "do it", "/w", looks)).toEqual({ project: "/proj", cardSpecs: [], mission: "do it" });
  });

  it("takes card specs alone, or after a project", () => {
    expect(resolveRunTarget(["cards-dir"], undefined, "/w", looks)).toEqual({ project: null, cardSpecs: ["cards-dir"], mission: "" });
    expect(resolveRunTarget(["a.md", "b.md"], undefined, "/w", looks)).toEqual({ project: null, cardSpecs: ["a.md", "b.md"], mission: "" });
    expect(resolveRunTarget(["/proj", "cards-dir"], undefined, "/w", looks)).toEqual({ project: "/proj", cardSpecs: ["cards-dir"], mission: "" });
  });

  it("refuses cards together with --mission", () => {
    expect(() => resolveRunTarget(["/proj", "cards-dir"], "mission", "/w", looks)).toThrow(/either --mission or task cards/);
  });
});

describe("flags", () => {
  it("parses --only and reads --brief", () => {
    expect(parseOnly(undefined)).toBeUndefined();
    expect(parseOnly("N01, N02,N03")).toEqual(["N01", "N02", "N03"]);
    expect(() => parseOnly(" , ")).toThrow(/at least one card id/);
    const { repo } = repoWithCards();
    writeFileSync(join(repo, "brief.md"), "  Be careful.\n");
    expect(readBrief("brief.md", repo)).toEqual({ brief: "Be careful.", briefSource: "brief.md" });
    expect(readBrief(undefined, repo)).toBeUndefined();
    expect(() => readBrief("nope.md", repo)).toThrow(/--brief file not found/);
  });

  it("finds the project of cards that live in a repository", () => {
    const { repo, tasks } = repoWithCards();
    expect(projectForCards(tasks)).toBe(repo);
    expect(projectForCards(join(tasks, "N01-a.md"))).toBe(repo);
    expect(projectForCards(join(tasks, "N0*.md"))).toBe(repo);
  });
});

describe("polako run <cards>", () => {
  function capture() {
    const calls: { method: string; params: Record<string, unknown> | undefined }[] = [];
    const daemonCall = <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      return Promise.resolve({ id: "run_x" } as T);
    };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    return { calls, daemonCall };
  }

  it("sends the parsed cards, --only and the brief, with the project found from the cards", async () => {
    const { repo, tasks } = repoWithCards();
    writeFileSync(join(repo, "brief.md"), "Brief.\n");
    const { calls, daemonCall } = capture();
    await runCli(["run", tasks, "--brief", join(repo, "brief.md"), "--only", "N02", "--detach"], { callDaemon: daemonCall });
    const params = calls[0]?.params ?? {};
    expect(calls[0]?.method).toBe("run");
    expect(params["project"]).toBe(repo);
    expect(params["mission"]).toBe("");
    expect((params["cards"] as { id: string }[]).map((card) => card.id)).toEqual(["N01", "N02"]);
    expect(params["only"]).toEqual(["N02"]);
    expect(params["brief"]).toBe("Brief.");
  });

  it("accepts an explicit project, a single card file and a glob", async () => {
    const { repo, tasks } = repoWithCards();
    const { calls, daemonCall } = capture();
    await runCli(["run", repo, join(tasks, "N01-a.md")], { callDaemon: daemonCall });
    await runCli(["run", join(tasks, "N0*.md")], { callDaemon: daemonCall });
    expect(calls.map((call) => call.params?.["project"])).toEqual([repo, repo]);
    expect((calls[0]?.params?.["cards"] as unknown[]).length).toBe(1);
    expect((calls[1]?.params?.["cards"] as unknown[]).length).toBe(2);
  });

  it("fails at the prompt on a broken card set, before any daemon call", async () => {
    const { repo, tasks } = repoWithCards();
    writeFileSync(join(tasks, "N03-c.md"), CARD("N03", "N99"));
    const { calls, daemonCall } = capture();
    await expect(runCli(["run", tasks], { callDaemon: daemonCall })).rejects.toThrow(/card N03 depends on unknown card N99/);
    writeFileSync(join(tasks, "N03-c.md"), CARD("N03", "N04"));
    writeFileSync(join(tasks, "N04-d.md"), CARD("N04", "N03"));
    await expect(runCli(["run", tasks], { callDaemon: daemonCall })).rejects.toThrow(/dependency cycle/);
    await expect(runCli(["run", repo, "--only", "N01"], { callDaemon: daemonCall })).rejects.toThrow(/apply to task cards/);
    expect(calls).toHaveLength(0);
  });

  it("--dry-run validates and prints the plan without calling the daemon", async () => {
    const { tasks } = repoWithCards();
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const calls: string[] = [];
    await runCli(["run", tasks, "--dry-run", "--only", "N02"], { callDaemon: <T>(method: string) => { calls.push(method); return Promise.resolve({} as T); } });
    expect(calls).toEqual([]);
    expect(written.join("")).toContain("1 card(s), no dependency problems:");
    expect(written.join("")).toContain("N02    -  files: src/N02.ts  accept: 1  Title N02");
    expect(written.join("")).toContain("(N02 depends on N01, not selected: assumed already in the code)");
  });

  it("leaves a mission run unchanged", async () => {
    const { repo } = repoWithCards();
    const { calls, daemonCall } = capture();
    await runCli(["run", repo, "--mission", "fix the bug", "--detach"], { callDaemon: daemonCall });
    await runCli(["run", repo, "add", "dark", "mode"], { callDaemon: daemonCall });
    expect(calls.map((call) => [call.params?.["project"], call.params?.["mission"], "cards" in (call.params ?? {})])).toEqual([
      [repo, "fix the bug", false],
      [repo, "add dark mode", false],
    ]);
  });
});
