import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../domain/config.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { openStore } from "../store/index.js";
import { buildProductionDeps, hydrateCatalog } from "./composition.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("hydrateCatalog (a daemon restarted mid-run)", () => {
  it("fills an empty catalogue so a resumed EXECUTING run finds its worker, and leaves a filled one alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polako-hydrate-"));
    dirs.push(dir);
    const store = openStore({ artifactsDir: join(dir, "artifacts") });
    const provider = new ScriptedProvider("local", [{ name: "ornith", capabilities: { ...FAKE_CAPABILITIES.strong, inputCostPerM: 0, outputCostPerM: 0 } }]);
    const deps = buildProductionDeps({ store, clock: new FakeClock(1_700_000_000_000), config: defaultConfig(), home: join(dir, "home"), providers: [provider] });

    // what a freshly started daemon has: no models, so no worker is eligible
    expect(deps.router.select({ role: "worker", count: 1, requireTools: true })).toEqual([]);
    await hydrateCatalog(deps);
    expect(deps.router.select({ role: "worker", count: 1, requireTools: true }).map((row) => row.entry.info.ref.model)).toEqual(["ornith"]);

    const before = deps.catalog.list();
    await hydrateCatalog(deps);
    expect(deps.catalog.list()).toEqual(before);
    store.close();
  });
});
