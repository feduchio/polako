import assert from "node:assert/strict";
import { describe, it } from "node:test";

for (let suite = 0; suite < 37; suite += 1) {
  describe(`suite ${String(suite)}`, () => {
    for (let n = 0; n < 10; n += 1) {
      it(`case ${String(suite)}.${String(n)}`, () => {
        assert.equal(suite * 10 + n >= 0, true);
      });
    }
  });
}
