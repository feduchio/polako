import { describe, expect, it } from "vitest";
import { anchorOf, applyHashlineEdits, NoopTracker, parseEdits, renderAnchored } from "./hashline.js";

const FILE = "export function add(a, b) {\n  return a - b;\n}\n";
const lines = FILE.replace(/\n$/, "").split("\n");
const at = (line: number) => anchorOf(line, lines[line - 1] ?? "");

describe("hashline edits", () => {
  it("renders each line with its anchor", () => {
    expect(renderAnchored(lines, 2, 2)).toBe(`${at(2)}|  return a - b;`);
  });

  it("replaces a line named by its anchor, keeping the final newline", () => {
    const { after, changed } = applyHashlineEdits(FILE, parseEdits([{ op: "replace", start: at(2), lines: ["  return a + b;"] }]));
    expect(after).toBe("export function add(a, b) {\n  return a + b;\n}\n");
    expect(changed).toEqual({ from: 2, to: 2 });
  });

  it("inserts at the top and after a line, and deletes a range, all anchored against the same read", () => {
    const { after } = applyHashlineEdits(FILE, parseEdits([
      { op: "insert_after", start: "0", lines: ["// sum"] },
      { op: "insert_after", start: at(1), lines: ["  const s = a + b;"] },
      { op: "replace", start: at(2), lines: ["  return s;"] },
    ]));
    expect(after).toBe("// sum\nexport function add(a, b) {\n  const s = a + b;\n  return s;\n}\n");
    expect(applyHashlineEdits(FILE, parseEdits([{ op: "delete", start: at(1), end: at(3) }])).after).toBe("");
  });

  it("refuses an anchor whose line changed since it was read, naming the new anchor", () => {
    const changed = FILE.replace("a - b", "a * b");
    expect(() => applyHashlineEdits(changed, parseEdits([{ op: "replace", start: at(2), lines: ["x"] }])))
      .toThrow(/line 2 changed since it was read .* now 2:[0-9a-f]{2}/);
    expect(() => applyHashlineEdits(FILE, parseEdits([{ op: "replace", start: "9:aa", lines: ["x"] }]))).toThrow(/line 9 does not exist/);
    expect(() => applyHashlineEdits(FILE, parseEdits([{ op: "replace", start: "  return a - b;", lines: ["x"] }]))).toThrow(/not an anchor/);
  });

  it("refuses overlapping edits", () => {
    expect(() => applyHashlineEdits(FILE, parseEdits([
      { op: "replace", start: at(1), end: at(2), lines: ["a"] },
      { op: "delete", start: at(2) },
    ]))).toThrow(/overlap/);
  });

  it("answers the third identical no-op with a stop", () => {
    const tracker = new NoopTracker();
    expect(tracker.refuse("src/add.mjs", "p").message).toMatch(/produced no change/);
    expect(tracker.refuse("src/add.mjs", "p").message).toMatch(/produced no change/);
    expect(tracker.refuse("src/add.mjs", "p").message).toMatch(/^STOP\. .* no-op 3 times/);
    expect(tracker.refuse("src/add.mjs", "q").message).toMatch(/produced no change/);
  });
});
