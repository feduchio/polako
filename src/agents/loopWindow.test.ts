import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCall } from "../broker/types.js";
import { estimateTokens } from "../context/types.js";
import { buildLoopDigest, buildWireWindow, loopDigestCap } from "./loopWindow.js";
import type { AgentToolResult, AgentTurn } from "./types.js";

/**
 * Written out rather than derived. The previous item shipped a check that read its expectation
 * through the table it was validating, so every possible table satisfied it.
 */
const EXPECTED_CAP: readonly (readonly [number, number])[] = [
  [32_000, 400],
  [16_000, 200],
  [8_000, 200],
  [80_000, 400],
  [16_001, 200],
  // Both values above and below sit on a clamp plateau, where neither the divisor nor the
  // rounding direction shows. These two are in the linear stretch: 24_000/80 is exactly 300, and
  // 24_040/80 is 300.5, which floors to 300 and rounds to 301.
  [24_000, 300],
  [24_040, 300],
];

describe("loopDigestCap", () => {
  it("derives the documented cap at the budgets the contract names", () => {
    for (const [budget, expected] of EXPECTED_CAP) {
      expect(loopDigestCap(budget)).toBe(expected);
    }
  });

  it("stays inside the bound over the whole budget domain, not only at sampled points", () => {
    for (let budget = 1; budget <= 200_000; budget += 37) {
      const cap = loopDigestCap(budget);
      expect(cap).toBeGreaterThanOrEqual(200);
      expect(cap).toBeLessThanOrEqual(400);
      // The worst-case break-even measured on this tree. Above it the change is a regression.
      expect(cap).toBeLessThan(851);
    }
  });
});

describe("buildLoopDigest", () => {
  it("names every non-terminal tool by its identifying argument", () => {
    const digest = buildLoopDigest(
      [
        turn(1, [ok("read", { path: "src/alpha.ts" }, { path: "src/alpha.ts" })]),
        turn(2, [ok("list", { path: "src" }, { path: "src" })]),
        turn(3, [ok("search", { query: "addTwo" }, { exitCode: 0 })]),
        turn(4, [ok("repo_intel", { action: "callers", query: "addTwo" }, {})]),
        turn(5, [ok("write", { path: "src/beta.ts" }, { path: "src/beta.ts" })]),
        turn(6, [ok("apply_patch", { path: "src/gamma.ts" }, { path: "src/gamma.ts" })]),
        turn(7, [ok("request_context", { query: "why is it slow" }, {})]),
      ],
      400,
    );
    expect(digest).toContain("src/alpha.ts");
    expect(digest).toContain("list src");
    expect(digest).toContain('search "addTwo"');
    expect(digest).toContain('callers "addTwo"');
    expect(digest).toContain("src/beta.ts (write)");
    expect(digest).toContain("src/gamma.ts (patch)");
    expect(digest).toContain('request_context "why is it slow"');
  });

  it("says an empty search found nothing, and counts the repeat", () => {
    const digest = buildLoopDigest(
      [1, 2, 3, 4].map((n) => turn(n, [
        ok("search", { query: "commit duration" }, { exitCode: 0, matchCount: 0, startLine: 1, endLine: 1, totalLines: 1, content: "" }),
      ])),
      400,
    );
    expect(digest).toContain('search "commit duration" (0 matches) (x4)');
  });

  it("says which part of a paged file a read saw, and how many entries a paged listing has", () => {
    const digest = buildLoopDigest(
      [
        turn(1, [ok("read", { path: "src/small.ts" }, { path: "src/small.ts", startLine: 1, endLine: 40, totalLines: 40, content: "x" })]),
        turn(2, [ok("read", { path: "src/long.ts" }, { path: "src/long.ts", startLine: 1, endLine: 700, totalLines: 3000, nextStartLine: 701, content: "x" })]),
        turn(3, [ok("read", { path: "src/long.ts", startLine: 701 }, { path: "src/long.ts", startLine: 701, endLine: 1400, totalLines: 3000, nextStartLine: 1401, content: "x" })]),
        turn(4, [ok("list", { path: "." }, { path: ".", entryCount: 1500, startLine: 1, endLine: 400, totalLines: 1500, nextStartLine: 401, content: "a\nb" })]),
      ],
      400,
    );
    expect(digest).toContain("read src/small.ts (lines 1-40)");
    expect(digest).not.toContain("(lines 1-40 of");
    expect(digest).toContain("read src/long.ts (lines 1-700 of 3000)");
    expect(digest).toContain("read src/long.ts (lines 701-1400 of 3000)");
    expect(digest).toContain("list . (1500 entries)");
  });

  it("keeps a failed command's stdout when its stderr is empty", () => {
    const digest = buildLoopDigest(
      [turn(1, [ok("run_command", { argv: ["npm", "test"] }, { exitCode: 1, content: "FAIL src/a.test.ts STDOUT-ONLY-FAILURE\n[stderr]\n" })])],
      400,
    );
    expect(digest).toContain("npm test -> exit 1: FAIL src/a.test.ts STDOUT-ONLY-FAILURE");
    expect(digest).not.toContain("(no output)");
  });

  it("evicts the oldest low-priority entry and keeps the newest command whole", () => {
    const turns = [
      turn(1, [ok("read", { path: "src/very-old-file.ts" }, { path: "src/very-old-file.ts" })]),
      ...[2, 3, 4, 5, 6].map((n) => turn(n, [ok("read", { path: `src/middle-${String(n)}.ts` }, { path: `src/middle-${String(n)}.ts` })])),
      turn(7, [ok("run_command", { argv: ["node", "newest-cmd"] }, { exitCode: 0, stdout: "fine" })]),
    ];
    const digest = buildLoopDigest(turns, 40);

    expect(estimateTokens(digest)).toBeLessThanOrEqual(40);
    expect(digest).toContain("node newest-cmd -> exit 0");
    expect(digest).not.toContain("very-old-file.ts");
  });

  it("carries the worker's recent prose and evicts the oldest of it first", () => {
    const noisy = (n: number): AgentTurn => ({
      ...turn(n, [ok("read", { path: `src/f${String(n)}.ts` }, { path: `src/f${String(n)}.ts` })]),
      assistant: {
        role: "assistant",
        content: n === 1 ? `DISTINCTIVE-ALPHA-MARKER ${"x".repeat(180)}` : `filler ${String(n)} ${"y".repeat(190)}`,
        toolCalls: [{ id: `c${String(n)}`, name: "read", arguments: JSON.stringify({ path: `src/f${String(n)}.ts` }) }],
      },
    });
    const turns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(noisy);

    const early = buildLoopDigest(turns.slice(0, 2), 400);
    const late = buildLoopDigest(turns, 400);

    expect(early).toContain("DISTINCTIVE-ALPHA-MARKER");
    expect(estimateTokens(late)).toBeLessThanOrEqual(400);
    expect(late).not.toContain("DISTINCTIVE-ALPHA-MARKER");
    expect(late).toContain("filler 14");
  });

  it("holds the cap on adversarial input while leaving every surviving entry whole", () => {
    const cap = 400;

    const manyReads = buildLoopDigest(
      Array.from({ length: 300 }, (_, i) => turn(i + 1, [ok("read", { path: `src/file-${String(i)}.ts` }, { path: `src/file-${String(i)}.ts` })])),
      cap,
    );
    expect(estimateTokens(manyReads)).toBeLessThanOrEqual(cap);

    const hugeOutput = buildLoopDigest(
      [turn(1, [ok("run_command", { argv: ["node", "big"] }, { exitCode: 1, stderr: "z".repeat(50_000) })])],
      cap,
    );
    expect(estimateTokens(hugeOutput)).toBeLessThanOrEqual(cap);
    expect(hugeOutput).toContain("exit 1");

    const hugeError = buildLoopDigest([turn(1, [failed("read", { path: "src/x.ts" }, "E".repeat(5_000))])], cap);
    expect(estimateTokens(hugeError)).toBeLessThanOrEqual(cap);

    const hugeArgv = buildLoopDigest(
      [turn(1, [ok("run_command", { argv: ["node", "a".repeat(50_000)] }, { exitCode: 0, stdout: "" })])],
      cap,
    );
    expect(estimateTokens(hugeArgv)).toBeLessThanOrEqual(cap);
    // No shortened form is specified for an argv, so the only legal move is to drop it whole.
    expect(hugeArgv).not.toContain("aaaa");

    // MC6 names the search query beside the argv, and only the argv was exercised: a mutant that
    // shortened the query to its last 80 characters left every other assertion green.
    const hugeQuery = buildLoopDigest(
      [
        turn(1, [ok("write", { path: "src/kept-beside-query.ts" }, { path: "src/kept-beside-query.ts" })]),
        turn(2, [ok("search", { query: "c".repeat(50_000) }, { exitCode: 0 })]),
      ],
      cap,
    );
    expect(estimateTokens(hugeQuery)).toBeLessThanOrEqual(cap);
    expect(hugeQuery).not.toContain("cccc");
    expect(hugeQuery).toContain("src/kept-beside-query.ts (write)");

    const overCapPath = `src/${"deep/".repeat(120)}leaf.ts`;
    const manyChanged = buildLoopDigest(
      [
        ...Array.from({ length: 300 }, (_, i) => turn(i + 1, [ok("write", { path: `src/w-${String(i)}.ts` }, { path: `src/w-${String(i)}.ts` })])),
        turn(301, [ok("write", { path: overCapPath }, { path: overCapPath })]),
      ],
      cap,
    );
    expect(estimateTokens(manyChanged)).toBeLessThanOrEqual(cap);
    const changedLine = manyChanged.split("\n").find((line) => line.startsWith("Changed: "));
    expect(changedLine).toBeDefined();
    for (const entry of changedLine!.slice("Changed: ".length).split("; ")) {
      // Whole entries only: a mid-entry truncation would lose the tag.
      expect(entry).toMatch(/^\u2026?[^;]+ \((write|patch)\)$/);
      expect(entry.length).toBeLessThanOrEqual(81 + " (write)".length);
    }
    const shortened = changedLine!.slice("Changed: ".length).split("; ").find((entry) => entry.includes("leaf.ts"));
    expect(shortened).toBeDefined();
    // MC6 requires the marker, so a reader can tell a shortened path from a real one.
    expect(shortened!.startsWith("\u2026")).toBe(true);
    expect(shortened!.length).toBeLessThanOrEqual(1 + 80 + " (write)".length);

    // An entry with no shortened form is dropped alone, not at the cost of everything else.
    const argvAmongOthers = buildLoopDigest(
      [
        turn(1, [ok("write", { path: "src/kept.ts" }, { path: "src/kept.ts" })]),
        turn(2, [ok("run_command", { argv: ["node", "b".repeat(50_000)] }, { exitCode: 0, stdout: "" })]),
        turn(3, [ok("read", { path: "src/also-kept.ts" }, { path: "src/also-kept.ts" })]),
      ],
      cap,
    );
    expect(estimateTokens(argvAmongOthers)).toBeLessThanOrEqual(cap);
    expect(argvAmongOthers).not.toContain("bbbb");
    expect(argvAmongOthers).toContain("src/kept.ts (write)");
    expect(argvAmongOthers).toContain("src/also-kept.ts");
  });

  it("keeps the higher-priority entry where age alone would have kept the other", () => {
    const line = (digest: string, label: string): string =>
      digest.split("\n").find((l) => l.startsWith(`${label}: `))?.slice(label.length + 2) ?? "";

    // Changed paths outlive newer reads. Only the oldest entry here is a change, so recency
    // cannot explain its survival.
    const changed = buildLoopDigest(
      [
        turn(1, [ok("write", { path: "src/kept-change.ts" }, { path: "src/kept-change.ts" })]),
        ...[2, 3, 4, 5, 6, 7].map((n) => turn(n, [ok("read", { path: `src/newer-read-${String(n)}.ts` }, { path: `src/newer-read-${String(n)}.ts` })])),
      ],
      18,
    );
    expect(line(changed, "Changed")).toBe("src/kept-change.ts (write)");
    expect(changed).not.toContain("newer-read-7.ts");

    // The failing command outlives newer successful ones.
    const failing = buildLoopDigest(
      [
        turn(1, [ok("run_command", { argv: ["node", "broke.js"] }, { exitCode: 9, stderr: "why" })]),
        turn(2, [ok("run_command", { argv: ["node", "fine-a.js"] }, { exitCode: 0, stdout: "" })]),
        turn(3, [ok("run_command", { argv: ["node", "fine-b.js"] }, { exitCode: 0, stdout: "" })]),
      ],
      20,
    );
    expect(failing).toContain("node broke.js -> exit 9");
    expect(failing).not.toContain("fine-b.js");

    // A command outlives newer reads, and a read outlives newer prose.
    const command = buildLoopDigest(
      [
        turn(1, [ok("run_command", { argv: ["node", "early.js"] }, { exitCode: 0, stdout: "" })]),
        ...[2, 3, 4].map((n) => turn(n, [ok("read", { path: `src/after-${String(n)}.ts` }, { path: `src/after-${String(n)}.ts` })])),
      ],
      18,
    );
    expect(command).toContain("node early.js -> exit 0");
    expect(command).not.toContain("after-4.ts");

    // Changed paths outlive even the newest failing command, which is the one adjacent pair the
    // four fixtures above skip.
    const overFailure = buildLoopDigest(
      [
        turn(1, [ok("write", { path: "src/kept.ts" }, { path: "src/kept.ts" })]),
        turn(2, [ok("run_command", { argv: ["node", "newer-broke.js"] }, { exitCode: 7, stderr: "nope" })]),
      ],
      16,
    );
    expect(overFailure).toContain("src/kept.ts (write)");
    expect(overFailure).not.toContain("newer-broke.js");

    const overError = buildLoopDigest(
      [
        turn(1, [ok("write", { path: "src/kept.ts" }, { path: "src/kept.ts" })]),
        turn(2, [failed("read", { path: "src/newer-denied.ts" }, "path escapes sandbox")]),
      ],
      16,
    );
    expect(overError).toContain("src/kept.ts (write)");
    expect(overError).not.toContain("newer-denied.ts");

    // A failed ordinary call ranks with the other tool calls, below commands: raising errors is
    // the plausible slip, since a failure looks more urgent than a command that succeeded.
    const overFailedCall = buildLoopDigest(
      [
        turn(1, [ok("run_command", { argv: ["node", "earlier-ok.js"] }, { exitCode: 0, stdout: "" })]),
        turn(2, [failed("read", { path: "src/newer-denied.ts" }, "path escapes sandbox")]),
      ],
      19,
    );
    expect(overFailedCall).toContain("node earlier-ok.js -> exit 0");
    expect(overFailedCall).not.toContain("newer-denied.ts");

    const noted = buildLoopDigest(
      [
        turn(1, [ok("read", { path: "src/early-read.ts" }, { path: "src/early-read.ts" })]),
        ...[2, 3].map((n) => ({ ...turn(n, []), assistant: { role: "assistant" as const, content: `later prose number ${String(n)}`, toolCalls: [] } })),
      ],
      18,
    );
    expect(noted).toContain("src/early-read.ts");
    expect(noted).not.toContain("later prose number 3");
  });

  it("says whether a call succeeded by where it lands, not merely that it happened", () => {
    const digest = buildLoopDigest(
      [
        turn(1, [ok("search", { query: "survivor" }, { exitCode: 0 })]),
        turn(2, [failed("search", { query: "casualty" }, "rg exited 2")]),
      ],
      400,
    );
    const tools = digest.split("\n").find((l) => l.startsWith("Tools: ")) ?? "";
    const errors = digest.split("\n").find((l) => l.startsWith("Errors: ")) ?? "";
    expect(tools).toContain('search "survivor"');
    expect(tools).not.toContain("casualty");
    expect(errors).toContain('search "casualty": rg exited 2');
    expect(errors).not.toContain("survivor");
  });

  it("keeps the output of the last failure only, even when both are in one turn", () => {
    const digest = buildLoopDigest(
      [
        turn(1, [
          ok("run_command", { argv: ["node", "first.js"] }, { exitCode: 5, stderr: "EARLIER-FAILURE-OUTPUT" }),
          ok("run_command", { argv: ["node", "second.js"] }, { exitCode: 6, stderr: "LATEST-FAILURE-OUTPUT" }),
        ]),
      ],
      400,
    );
    expect(digest).toContain("node second.js -> exit 6: LATEST-FAILURE-OUTPUT");
    expect(digest).toContain("node first.js -> exit 5");
    // A turn number cannot order two calls inside one turn; the call position can.
    expect(digest).not.toContain("EARLIER-FAILURE-OUTPUT");
  });

  it("renders a failure from the end of its output, bounded, and says when it shortened", () => {
    const long = `HEAD-OF-THE-OUTPUT ${"m".repeat(400)} TAIL-OF-THE-OUTPUT`;
    const digest = buildLoopDigest(
      [turn(1, [ok("run_command", { argv: ["node", "x.js"] }, { exitCode: 1, stderr: long })])],
      400,
    );
    // A stack trace is diagnosed from its end, so the end is what survives.
    expect(digest).toContain("TAIL-OF-THE-OUTPUT");
    expect(digest).not.toContain("HEAD-OF-THE-OUTPUT");
    const rendered = digest.split("exit 1: ")[1] ?? "";
    expect(rendered.length).toBeLessThanOrEqual(201);
    expect(rendered.startsWith("\u2026")).toBe(true);

    const longError = buildLoopDigest(
      [turn(1, [failed("read", { path: "src/x.ts" }, `HEAD-OF-THE-ERROR ${"e".repeat(400)} TAIL-OF-THE-ERROR`)])],
      400,
    );
    expect(longError).toContain("TAIL-OF-THE-ERROR");
    expect(longError).not.toContain("HEAD-OF-THE-ERROR");
    expect((longError.split("src/x.ts: ")[1] ?? "").length).toBeLessThanOrEqual(201);
  });

  it("names what a failed call was aimed at, not merely that it failed", () => {
    const digest = buildLoopDigest(
      [
        turn(1, [failed("read", { path: "src/forbidden.ts" }, "path escapes sandbox")]),
        turn(2, [failed("run_command", { argv: ["node", "denied.js"] }, "command not in allowlist")]),
        turn(3, [failed("read", { path: "src/forbidden.ts" }, "path escapes sandbox")]),
      ],
      400,
    );
    expect(digest).toContain("read src/forbidden.ts: path escapes sandbox");
    expect(digest).toContain("run_command node denied.js: command not in allowlist");
    // The same failure twice is one entry with a count, not two.
    expect(digest).toContain("(x2)");
  });

  it("is empty before there is any history to summarise", () => {
    expect(buildLoopDigest([], 400)).toBe("");
  });
});

describe("buildWireWindow", () => {
  const pack: ChatMessage = { role: "user", content: "the composed instruction pack" };

  it("sends the fixed prompt alone on the first turn", () => {
    const window = buildWireWindow({
      archive: [{ role: "system", content: "sys" }, pack],
      turns: [],
      digestCap: 400,
    });
    expect(window.map((message) => message.role)).toEqual(["system", "user"]);
    expect(window.at(-1)?.content).toBe(pack.content);

    // The contract says "the system message, if any, plus the pack", so the no-system branch is
    // a named case and not an implicit one.
    expect(buildWireWindow({ archive: [pack], turns: [], digestCap: 400 })).toEqual([pack]);
  });

  it("summarises only what precedes the turn it sends verbatim", () => {
    const archive: ChatMessage[] = [
      pack,
      { role: "assistant", content: "", toolCalls: [{ id: "old", name: "read", arguments: "{}" }] },
      { role: "tool", toolCallId: "old", content: "older output" },
      { role: "assistant", content: "", toolCalls: [{ id: "new", name: "read", arguments: "{}" }] },
      { role: "tool", toolCallId: "new", content: "newest output" },
    ];
    const window = buildWireWindow({
      archive,
      turns: [
        turn(1, [ok("read", { path: "src/older.ts" }, { path: "src/older.ts" })]),
        turn(2, [ok("read", { path: "src/newest.ts" }, { path: "src/newest.ts" })]),
      ],
      digestCap: 400,
    });
    const body = window.map((message) => message.content).join("\n");
    expect(body).toContain("src/older.ts");
    // The newest turn is already present verbatim; digesting it too would pay for it twice.
    expect(body).not.toContain("src/newest.ts");
    expect(body).toContain("newest output");
  });

  it("carries the system message on every turn, not only the first", () => {
    const archive: ChatMessage[] = [
      { role: "system", content: "the standing system message" },
      pack,
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", arguments: "{}" }] },
      { role: "tool", toolCallId: "a", content: "first" },
      { role: "assistant", content: "", toolCalls: [{ id: "b", name: "read", arguments: "{}" }] },
      { role: "tool", toolCallId: "b", content: "second" },
    ];
    const window = buildWireWindow({
      archive,
      turns: [
        turn(1, [ok("read", { path: "src/a.ts" }, { path: "src/a.ts" })]),
        turn(2, [ok("read", { path: "src/b.ts" }, { path: "src/b.ts" })]),
      ],
      digestCap: 400,
    });
    // Turn 1 is not the interesting case: a prompt dropped only once the digest appears is the
    // plausible mistake.
    expect(window[0]).toEqual({ role: "system", content: "the standing system message" });
    expect(window[1]?.content).toBe(pack.content);
  });

  it("keeps a multi-call turn's results paired with the assistant that asked for them", () => {
    const calls: ToolCall[] = [
      { id: "a", name: "read", arguments: JSON.stringify({ path: "src/a.ts" }) },
      { id: "b", name: "read", arguments: JSON.stringify({ path: "src/b.ts" }) },
    ];
    const archive: ChatMessage[] = [
      pack,
      { role: "assistant", content: "", toolCalls: [{ id: "z", name: "read", arguments: "{}" }] },
      { role: "tool", toolCallId: "z", content: "first turn output" },
      { role: "assistant", content: "two at once", toolCalls: calls },
      { role: "tool", toolCallId: "a", content: "alpha body" },
      { role: "tool", toolCallId: "b", content: "beta body" },
    ];
    const window = buildWireWindow({
      archive,
      turns: [turn(1, [ok("read", { path: "src/z.ts" }, { path: "src/z.ts" })]), turn(2, [])],
      digestCap: 400,
    });

    expect(window.map((message) => message.role)).toEqual(["user", "user", "assistant", "tool", "tool"]);
    expect(window.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(calls.map((c) => c.id));
    expect(window.at(-2)?.content).toBe("alpha body");
    expect(window.at(-1)?.content).toBe("beta body");
    expect(window[1]?.content).toContain("## Earlier in this loop");
    // The older turn's output is in the archive, not on the wire.
    expect(window.map((m) => m.content).join("\n")).not.toContain("first turn output");
  });
});

describe("demotion of older failing commands", () => {
  /**
   * The demoted entry used to be produced by re-parsing the rendered line, and the separator it
   * looked for is a sequence an argv is free to contain.
   */
  it("keeps the exit code when the argv itself contains a colon and a space", () => {
    const digest = buildLoopDigest(
      [
        turn(1, [ok("run_command", { argv: ["git", "commit", "-m", "fix: x"] }, { exitCode: 1, stderr: "nothing to commit" })]),
        turn(2, [ok("run_command", { argv: ["node", "newer-broke.js"] }, { exitCode: 3, stderr: "later failure" })]),
      ],
      400,
    );
    expect(digest).toContain("git commit -m fix: x -> exit 1");
    // Demoted, so its output is gone while the newest failure keeps its own.
    expect(digest).not.toContain("nothing to commit");
    expect(digest).toContain("later failure");
  });

  it("demotes by dropping the output, not by truncating the line", () => {
    const digest = buildLoopDigest(
      [
        turn(1, [ok("run_command", { argv: ["node", "older.js"] }, { exitCode: 4, stderr: "older output" })]),
        turn(2, [ok("run_command", { argv: ["node", "newer.js"] }, { exitCode: 5, stderr: "newer output" })]),
      ],
      400,
    );
    expect(digest).toContain("node older.js -> exit 4");
    expect(digest).not.toContain("older output");
    expect(digest).toContain("node newer.js -> exit 5: newer output");
  });

  /**
   * The cap must be measured on the string that is emitted. Measuring `text` alone does not
   * overflow the digest — the outer eviction loop still refuses it — it silently empties it,
   * because the oversized entry sorts first and eviction only drops from the end.
   */
  it("evicts an entry whose tail overflows the cap without taking the rest with it", () => {
    const cap = 40;
    const digest = buildLoopDigest(
      [
        turn(1, [ok("run_command", { argv: ["node", "huge.js"] }, { exitCode: 1, stderr: "T".repeat(4_000) })]),
        turn(2, [ok("run_command", { argv: ["node", "small.js"] }, { exitCode: 0, stdout: "" })]),
      ],
      cap,
    );
    expect(digest).toContain("node small.js -> exit 0");
    expect(digest).not.toContain("TTTT");
    expect(estimateTokens(digest)).toBeLessThanOrEqual(cap);
  });
});

function turn(n: number, results: AgentToolResult[]): AgentTurn {
  return {
    turn: n,
    assistant: {
      role: "assistant",
      content: "",
      toolCalls: results.map((result) => ({
        id: result.toolCallId,
        name: result.name,
        arguments: ARGS.get(result.toolCallId) ?? "{}",
      })),
    },
    usage: { inputTokens: 10, outputTokens: 5, costUsd: null },
    toolResults: results,
  };
}

/** Tool arguments live beside the results so a synthetic turn can carry both. */
const ARGS = new Map<string, string>();
let nextId = 0;

function ok(name: string, args: Record<string, unknown>, output: unknown): AgentToolResult {
  const toolCallId = `call-${String(nextId += 1)}`;
  ARGS.set(toolCallId, JSON.stringify(args));
  return { toolCallId, name, ok: true, output };
}

function failed(name: string, args: Record<string, unknown>, error: string): AgentToolResult {
  const toolCallId = `call-${String(nextId += 1)}`;
  ARGS.set(toolCallId, JSON.stringify(args));
  return { toolCallId, name, ok: false, error };
}
