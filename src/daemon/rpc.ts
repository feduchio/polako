import { createConnection, createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { errorToString } from "../shared/errors.js";
import { RpcRequestSchema, type RpcHandler, type RpcResponse } from "./protocol.js";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export class RpcServer {
  private server: Server | null = null;

  constructor(
    readonly socketPath: string,
    private readonly handler: RpcHandler,
  ) {}

  async listen(): Promise<void> {
    if (this.server !== null) return;
    removeSocket(this.socketPath);
    const server = createServer((socket) => {
      this.accept(socket);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    removeSocket(this.socketPath);
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_MESSAGE_BYTES) {
        socket.destroy(new Error("RPC message exceeds size limit"));
        return;
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim() !== "") void this.respond(socket, line);
      }
    });
  }

  private async respond(socket: Socket, line: string): Promise<void> {
    let response: RpcResponse;
    try {
      const request = RpcRequestSchema.parse(JSON.parse(line));
      const result = await this.handler.handle(request.method, request.params ?? {});
      response = { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      response = {
        jsonrpc: "2.0",
        id: requestId(line),
        error: { code: -32_000, message: errorToString(error) },
      };
    }
    socket.write(`${JSON.stringify(response)}\n`);
  }
}

let nextRequestId = 1;

export function rpcCall<T>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 5_000,
): Promise<T> {
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffered = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`RPC ${method} timed out`));
    }, timeoutMs);
    const finish = (): void => {
      clearTimeout(timer);
      socket.end();
    };
    socket.setEncoding("utf8");
    socket.once("error", (error) => {
      finish();
      reject(error);
    });
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffered.slice(0, newline)) as RpcResponse;
        finish();
        if ("error" in response) reject(new Error(response.error.message));
        else resolve(response.result as T);
      } catch (error) {
        finish();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  });
}

function requestId(line: string): string | number | null {
  try {
    const value = JSON.parse(line) as { id?: unknown };
    return typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
  } catch {
    return null;
  }
}

function removeSocket(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
