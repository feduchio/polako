import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autostartDaemon } from "../cli/client.js";
import { polishPidPath } from "../daemon/main.js";
import { McpFacade, runMcpServer } from "./index.js";

let daemonPid: number | null = null;
let home: string | null = null;

afterEach(() => {
  if (daemonPid !== null) {
    try { process.kill(daemonPid, "SIGTERM"); } catch { /* already stopped */ }
  }
  if (home !== null) rmSync(home, { recursive: true, force: true });
  daemonPid = null;
  home = null;
  delete process.env["POLAKO_HOME"];
});

describe("polish-mcp", () => {
  it("speaks stdio to a real daemon and does not answer notifications", async () => {
    home = mkdtempSync(join(tmpdir(), "polish-mcp-"));
    process.env["POLAKO_HOME"] = home;
    await autostartDaemon();
    daemonPid = Number(readFileSync(polishPidPath(home), "utf8").trim());

    const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/index.ts"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });

    const next = async (): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 5_000;
      while (lines.length === 0) {
        if (Date.now() > deadline) throw new Error("mcp produced no response");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return JSON.parse(lines.shift() ?? "{}") as Record<string, unknown>;
    };

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    const initialized = await next();
    expect(initialized["id"]).toBe(1);
    expect(JSON.stringify(initialized["result"])).toContain("polako");

    const before = lines.length;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lines.length).toBe(before);

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
    expect((await next())["id"]).toBe(2);

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
    const listed = await next();
    const tools = (listed["result"] as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(tools).toContain("daemon.ping");
    expect(tools).toContain("status");

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "status", arguments: {} },
    })}\n`);
    const status = await next();
    expect(status["error"]).toBeUndefined();
    expect(JSON.stringify(status["result"])).toContain("structuredContent");

    child.kill();
  });
});

describe("polish-mcp in process", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers ping with an empty result without shadowing the methods after it", async () => {
    const facade = new McpFacade();
    await expect(facade.handle({ method: "ping" })).resolves.toEqual({});
    const listed = await facade.handle({ method: "tools/list" }) as { tools?: { name: string }[] };
    expect(listed.tools?.map((tool) => tool.name)).toContain("status");
  });

  it("replies to a request with its id and stays silent on a notification", async () => {
    const stdin = new PassThrough();
    const written: string[] = [];
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    runMcpServer();
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`);
    await vi.waitFor(() => {
      expect(written.some((line) => line.includes('"id":7'))).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.end();
    expect(written.map((line) => JSON.parse(line) as unknown)).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
  });
});
