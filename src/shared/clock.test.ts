import { describe, expect, it } from "vitest";
import { FakeClock } from "./clock.js";
import { hashJson } from "./hash.js";
import { newId } from "./ids.js";

describe("FakeClock", () => {
  it("fires sleepers in timestamp order as time advances", async () => {
    const clock = new FakeClock(0);
    const order: string[] = [];
    void clock.sleep(30).then(() => order.push("c"));
    void clock.sleep(10).then(() => order.push("a"));
    void clock.sleep(20).then(() => order.push("b"));
    await clock.advance(25);
    expect(order).toEqual(["a", "b"]);
    expect(clock.now()).toBe(25);
    await clock.advance(10);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("fires sleepers registered re-entrantly at the current time during advance", async () => {
    const clock = new FakeClock(0);
    const order: string[] = [];
    void clock.sleep(10).then(async () => {
      // a long promise chain before scheduling the nested sleep
      for (let i = 0; i < 20; i++) await Promise.resolve();
      order.push("outer");
      await clock.sleep(0);
      order.push("nested");
    });
    await clock.advance(10);
    expect(order).toEqual(["outer", "nested"]);
    expect(clock.pendingSleepers()).toBe(0);
  });

  it("completes a large finite chain of zero-delay re-entrant sleepers", async () => {
    const clock = new FakeClock(0);
    let fired = 0;
    const limit = 100_001;
    const again = (): void => {
      fired++;
      if (fired < limit) void clock.sleep(0).then(again);
    };
    void clock.sleep(0).then(again);
    await clock.advance(0);
    expect(fired).toBe(limit);
    expect(clock.pendingSleepers()).toBe(0);
  });

  it("completes two concurrent finite chains of zero-delay re-entrant sleepers", async () => {
    const clock = new FakeClock(0);
    const limit = 50_001;
    let firedA = 0;
    let firedB = 0;
    const againA = (): void => {
      firedA++;
      if (firedA < limit) void clock.sleep(0).then(againA);
    };
    const againB = (): void => {
      firedB++;
      if (firedB < limit) void clock.sleep(0).then(againB);
    };
    void clock.sleep(0).then(againA);
    void clock.sleep(0).then(againB);
    await clock.advance(0);
    expect(firedA).toBe(limit);
    expect(firedB).toBe(limit);
    expect(clock.pendingSleepers()).toBe(0);
  });

  it("rejects an infinite chain of zero-delay re-entrant sleepers", async () => {
    const clock = new FakeClock(0, 1000);
    const again = (): void => {
      void clock.sleep(0).then(again);
    };
    void clock.sleep(0).then(again);
    await expect(clock.advance(0)).rejects.toThrow(/re-registering/);
  });

  it("rejects an aborted sleep", async () => {
    const clock = new FakeClock(0);
    const ac = new AbortController();
    const p = clock.sleep(100, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(clock.pendingSleepers()).toBe(0);
  });
});

describe("ids and hashes", () => {
  it("ids sort by creation time", () => {
    const a = newId("run", 1000);
    const b = newId("run", 2000);
    expect(a < b).toBe(true);
    expect(a.startsWith("run_")).toBe(true);
  });

  it("hashJson is key-order independent", () => {
    expect(hashJson({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashJson({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });
});
