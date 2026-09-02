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
