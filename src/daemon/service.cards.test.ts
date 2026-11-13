import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CARDS_REGISTERED_EVENT, type CardRegistration } from "../cards/index.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import { FakeClock } from "../shared/clock.js";
import { DaemonService } from "./service.js";

const dirs: string[] = [];
const services: DaemonService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const card = (id: string, depends: string[] = []) => ({ id, title: `Title ${id}`, depends, files: ["src/*.ts"], goal: `Goal ${id}.`, acceptance: [`${id} holds`] });

describe("polako run with task cards (RPC)", () => {
  it("registers the cards, the brief and --only on the run, and names the cards in the mission", async () => {
    const f = await fixture();
    const run = (await f.service.handle("run", {
      project: f.repoDir,
      cards: [card("A"), card("B", ["A"]), card("C", ["B"])],
      only: ["B", "C"],
      brief: "Brief from --brief.",
      briefSource: "brief.md",
    })) as { id: string; missionId: string };

    const [event] = f.service.store.events.list(run.id, { types: [CARDS_REGISTERED_EVENT] });
    const registration = event?.payload["registration"] as CardRegistration;
    expect(registration.cards.map((c) => [c.id, c.depends])).toEqual([["B", []], ["C", ["B"]]]);
    expect(registration).toMatchObject({ brief: "Brief from --brief.", briefSource: "brief.md", droppedDependencies: [{ card: "B", dependsOn: "A" }] });
    expect(f.service.store.repos.missions.get(run.missionId)?.text).toBe("Execute the task cards:\nB: Title B\nC: Title C");
  });

  it("takes the brief from cards.brief in the config when --brief is absent", async () => {
    const f = await fixture('[cards]\nbrief = "docs/brief.md"\n');
    const run = (await f.service.handle("run", { project: f.repoDir, cards: [card("A")] })) as { id: string };
    const registration = f.service.store.events.list(run.id, { types: [CARDS_REGISTERED_EVENT] })[0]?.payload["registration"] as CardRegistration;
    expect(registration).toMatchObject({ brief: "Repo brief.", briefSource: "docs/brief.md" });
  });

  it("refuses before any run exists: unknown dependency, cycle, unknown --only, missing configured brief", async () => {
    const f = await fixture();
    await expect(f.service.handle("run", { project: f.repoDir, cards: [card("A", ["Z"])] })).rejects.toThrow(/card A depends on unknown card Z/);
    await expect(f.service.handle("run", { project: f.repoDir, cards: [card("A", ["B"]), card("B", ["A"])] })).rejects.toThrow(/dependency cycle/);
    await expect(f.service.handle("run", { project: f.repoDir, cards: [card("A")], only: ["Q"] })).rejects.toThrow(/unknown card\(s\): Q/);
    await expect(f.service.handle("run", { project: f.repoDir, cards: [{ id: "A" }] })).rejects.toThrow(/invalid task cards/);
    expect(f.service.store.repos.runs.listAll()).toHaveLength(0);

    const g = await fixture('[cards]\nbrief = "docs/missing.md"\n');
    await expect(g.service.handle("run", { project: g.repoDir, cards: [card("A")] })).rejects.toThrow(/cards.brief docs\/missing.md is missing/);
    expect(g.service.store.repos.runs.listAll()).toHaveLength(0);
  });

  it("leaves a mission run exactly as before: no cards event", async () => {
    const f = await fixture();
    const run = (await f.service.handle("run", { project: f.repoDir, mission: "do a thing" })) as { id: string; missionId: string };
    expect(f.service.store.events.list(run.id, { types: [CARDS_REGISTERED_EVENT] })).toHaveLength(0);
    expect(f.service.store.repos.missions.get(run.missionId)?.text).toBe("do a thing");
  });
});

async function fixture(config = ""): Promise<{ service: DaemonService; repoDir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "polako-cards-service-"));
  dirs.push(dir);
  const repoDir = join(dir, "repo");
  mkdirSync(join(repoDir, "docs"), { recursive: true });
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "fixture", scripts: {} }));
  writeFileSync(join(repoDir, "docs", "brief.md"), "Repo brief.\n");
  const git = await Git.init(repoDir);
  await git.commitAll("init");
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "polako.toml"), config);
  const service = new DaemonService({
    home,
    clock: new FakeClock(1_700_000_000_000),
    providers: [new ScriptedProvider("scripted", [{ name: "worker", capabilities: FAKE_CAPABILITIES.frontier }])],
    tickMs: 1,
  });
  services.push(service);
  return { service, repoDir };
}
