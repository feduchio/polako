import { describe, expect, it } from "vitest";
import { ResidencyScheduler, type ResidencyControl, type ResidencyEvent, type ResidentInstance } from "./residency.js";

/** A server that holds instances, records every command, and fails if two loads ever overlap. */
class FakeServer implements ResidencyControl {
  instances: ResidentInstance[];
  readonly log: string[] = [];
  loading = 0;
  maxConcurrentLoads = 0;
  failNextLoad = false;

  constructor(initial: ResidentInstance[] = []) {
    this.instances = [...initial];
  }

  loaded(): Promise<ResidentInstance[]> {
    this.log.push("ps");
    return Promise.resolve([...this.instances]);
  }

  async load(modelKey: string, identifier: string): Promise<void> {
    this.log.push(`load:${modelKey}`);
    this.loading += 1;
    this.maxConcurrentLoads = Math.max(this.maxConcurrentLoads, this.loading);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.loading -= 1;
    if (this.failNextLoad) {
      this.failNextLoad = false;
      throw new Error("load failed");
    }
    this.instances.push({ modelKey, identifier });
  }

  unload(identifier: string): Promise<void> {
    this.log.push(`unload:${identifier}`);
    this.instances = this.instances.filter((instance) => instance.identifier !== identifier);
    return Promise.resolve();
  }
}

const loadsAndUnloads = (server: FakeServer): string[] => server.log.filter((entry) => entry !== "ps");

describe("ResidencyScheduler", () => {
  it("loads the model on first use and reuses it", async () => {
    const server = new FakeServer();
    const scheduler = new ResidencyScheduler({ control: server });
    const seen: string[] = [];
    await scheduler.run("a", (id) => Promise.resolve(seen.push(id)));
    await scheduler.run("a", (id) => Promise.resolve(seen.push(id)));
    expect(seen).toEqual(["a", "a"]);
    expect(loadsAndUnloads(server)).toEqual(["load:a"]);
    expect(scheduler.stats()).toMatchObject({ resident: "a", served: 2, swaps: 1 });
  });

  it("unloads the old model before loading the next and never overlaps loads", async () => {
    const server = new FakeServer();
    const events: ResidencyEvent[] = [];
    const scheduler = new ResidencyScheduler({ control: server, onEvent: (event) => events.push(event) });
    await Promise.all([scheduler.run("a", () => Promise.resolve()), scheduler.run("b", () => Promise.resolve()), scheduler.run("c", () => Promise.resolve())]);
    expect(loadsAndUnloads(server)).toEqual(["load:a", "unload:a", "load:b", "unload:b", "load:c"]);
    expect(server.maxConcurrentLoads).toBe(1);
    expect(events.filter((event) => event.type === "swap")).toHaveLength(3);
  });

  it("serves queued calls of the resident model first to save swaps", async () => {
    const server = new FakeServer();
    const scheduler = new ResidencyScheduler({ control: server });
    const order: string[] = [];
    // `a` is running (and holds the queue) while b, a, b, a arrive.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = scheduler.run("a", async () => {
      await gate;
      order.push("a1");
    });
    const rest = [
      scheduler.run("b", () => Promise.resolve(order.push("b1"))),
      scheduler.run("a", () => Promise.resolve(order.push("a2"))),
      scheduler.run("b", () => Promise.resolve(order.push("b2"))),
      scheduler.run("a", () => Promise.resolve(order.push("a3"))),
    ];
    release();
    await Promise.all([first, ...rest]);
    expect(order).toEqual(["a1", "a2", "a3", "b1", "b2"]);
    expect(scheduler.stats().swaps).toBe(2);
  });

  it("does not starve an old call: maxBatch and maxWaitMs bring it forward", async () => {
    const server = new FakeServer();
    let now = 0;
    const scheduler = new ResidencyScheduler({ control: server, now: () => now, maxBatch: 2, maxWaitMs: 1_000 });
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = scheduler.run("a", async () => {
      await gate;
      order.push("a1");
    });
    const rest = [
      scheduler.run("b", () => Promise.resolve(order.push("b1"))),
      scheduler.run("a", () => Promise.resolve(order.push("a2"))),
      scheduler.run("a", () => Promise.resolve(order.push("a3"))),
      scheduler.run("a", () => Promise.resolve(order.push("a4"))),
    ];
    release();
    await Promise.all([first, ...rest]);
    // a1, a2 fill maxBatch=2; b1 then goes although a3/a4 are waiting for the resident model.
    expect(order).toEqual(["a1", "a2", "b1", "a3", "a4"]);

    now = 10_000;
    const late: string[] = [];
    let release2: () => void = () => undefined;
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    const holder = scheduler.run("a", async () => {
      await gate2;
      late.push("a5");
    });
    const old = scheduler.run("b", () => Promise.resolve(late.push("b2")));
    now = 20_000; // b2 has waited past maxWaitMs
    const fresh = scheduler.run("a", () => Promise.resolve(late.push("a6")));
    release2();
    await Promise.all([holder, old, fresh]);
    expect(late).toEqual(["a5", "b2", "a6"]);
  });

  it("unloads a stray second model and uses the alias of an already loaded one", async () => {
    const server = new FakeServer([
      { modelKey: "ornith", identifier: "night" },
      { modelKey: "other", identifier: "other" },
    ]);
    const scheduler = new ResidencyScheduler({ control: server });
    const seen: string[] = [];
    await scheduler.run("ornith", (id) => Promise.resolve(seen.push(id)));
    expect(seen).toEqual(["night"]);
    expect(loadsAndUnloads(server)).toEqual(["unload:other"]);
  });

  it("recovers after a failed load: the caller sees the error and the next call tries again", async () => {
    const server = new FakeServer();
    const scheduler = new ResidencyScheduler({ control: server });
    server.failNextLoad = true;
    await expect(scheduler.run("a", () => Promise.resolve())).rejects.toThrow("load failed");
    await expect(scheduler.run("a", () => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(server.instances.map((instance) => instance.modelKey)).toEqual(["a"]);
  });

  it("propagates a call's own failure without disturbing the queue", async () => {
    const server = new FakeServer();
    const scheduler = new ResidencyScheduler({ control: server });
    const results = await Promise.allSettled([
      scheduler.run("a", () => Promise.reject(new Error("boom"))),
      scheduler.run("a", () => Promise.resolve("fine")),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
  });

  it("drops a queued call whose signal aborts", async () => {
    const server = new FakeServer();
    const scheduler = new ResidencyScheduler({ control: server });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = scheduler.run("a", () => gate);
    const controller = new AbortController();
    const queued = scheduler.run("b", () => Promise.resolve("never"), controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    release();
    await running;
    expect(loadsAndUnloads(server)).toEqual(["load:a"]);
  });

  it("unloadAll runs after earlier calls and before later ones", async () => {
    const server = new FakeServer();
    const scheduler = new ResidencyScheduler({ control: server });
    const order: string[] = [];
    await Promise.all([
      scheduler.run("a", () => Promise.resolve(order.push("a"))),
      scheduler.unloadAll().then(() => order.push(`unloaded:${String(server.instances.length)}`)),
      scheduler.run("a", () => Promise.resolve(order.push("a-again"))),
    ]);
    expect(order).toEqual(["a", "unloaded:0", "a-again"]);
    expect(loadsAndUnloads(server)).toEqual(["load:a", "unload:a", "load:a"]);
  });

  it("re-reads the server after recheckMs, noticing a model unloaded behind its back", async () => {
    const server = new FakeServer();
    let now = 0;
    const scheduler = new ResidencyScheduler({ control: server, now: () => now, recheckMs: 1_000 });
    await scheduler.run("a", () => Promise.resolve());
    server.instances = [];
    now = 5_000;
    await scheduler.run("a", () => Promise.resolve());
    expect(loadsAndUnloads(server)).toEqual(["load:a", "load:a"]);
  });
});
