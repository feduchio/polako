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
    expect(changedLine).toContain("leaf.ts (write)");
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
