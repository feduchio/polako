import { add } from "../src/math.js";

export function testAdd(): void {
  if (add(1, 1) !== 2) throw new Error("fail");
}
