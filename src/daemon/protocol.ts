import { z } from "zod";

export const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcResponse =
  | { jsonrpc: "2.0"; id: string | number; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: RpcError };

export const RPC_METHODS = [
  "daemon.ping",
  "project.add",
  "run",
  "status",
  "log",
  "diff",
  "pause",
  "resume",
  "stop",
  "kill",
  "answer",
  "apply",
  "benchmark.review",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

export interface RpcHandler {
  handle(method: string, params: Record<string, unknown>): Promise<unknown>;
}
