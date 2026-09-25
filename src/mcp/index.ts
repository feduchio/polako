#!/usr/bin/env node
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { callDaemon } from "../cli/client.js";
import { RPC_METHODS } from "../daemon/protocol.js";

interface McpRequest {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export class McpFacade {
  async handle(request: McpRequest): Promise<unknown> {
    if (request.method === "initialize") {
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "polish", version: "0.1.0" },
      };
    }
    if (request.method === "ping") return {};
    if (request.method === "tools/list") {
      return {
        tools: RPC_METHODS.map((method) => ({
          name: method,
          description: `Call the polish daemon's ${method} RPC method`,
          inputSchema: { type: "object", additionalProperties: true },
        })),
      };
    }
    if (request.method === "tools/call") {
      const name = request.params?.["name"];
      const args = request.params?.["arguments"];
      if (typeof name !== "string") throw new Error("tools/call requires a tool name");
      if (!RPC_METHODS.some((method) => method === name)) throw new Error(`unknown polish tool ${name}`);
      const params = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
      try {
        const result = await callDaemon(name, params);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    }
    throw new Error(`unsupported MCP method ${request.method}`);
  }
}

export function runMcpServer(): void {
  const facade = new McpFacade();
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line.trim() === "") return;
    void respond(facade, line);
  });
}

async function respond(facade: McpFacade, line: string): Promise<void> {
  let id: string | number | null = null;
  try {
    const request = JSON.parse(line) as McpRequest;
    if (request.id === undefined) return;
    id = request.id;
    const result = await facade.handle(request);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32_000, message: error instanceof Error ? error.message : String(error) },
    })}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runMcpServer();
