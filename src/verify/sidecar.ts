import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { PairwiseJudge } from "./pairwise.js";
import type {
  PairwiseContext,
  PairwiseVerdict,
  TournamentCandidate,
  VerifierStrategy,
} from "./strategy.js";

export interface VerifierSidecarOptions {
  command?: string;
  scriptPath?: string;
  requestTimeoutMs?: number;
  fallback?: VerifierStrategy;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * JSON-lines verifier transport. A failed request gets one clean restart; if that also
 * fails, comparison falls back to the deterministic TypeScript pairwise judge.
 */
export class VerifierAdapter implements VerifierStrategy {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly fallback: VerifierStrategy;
  private readonly command: string;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;

  constructor(options: VerifierSidecarOptions = {}) {
    this.command = options.command ?? "python3";
    this.scriptPath =
      options.scriptPath ??
      fileURLToPath(new URL("../../sidecars/llm_verifier/main.py", import.meta.url));
    this.timeoutMs = options.requestTimeoutMs ?? 2_000;
    this.fallback = options.fallback ?? new PairwiseJudge();
  }

  async comparePair(
    a: TournamentCandidate,
    b: TournamentCandidate,
    context: PairwiseContext,
  ): Promise<PairwiseVerdict> {
    const request = {
      op: "score_pair",
      candidates: [a, b],
      context,
      criteria: decomposeCriteria(context.task),
    };
    try {
      return parseVerdict(await this.request(request), a.id, b.id);
    } catch {
      try {
        await this.restart();
        return parseVerdict(await this.request(request), a.id, b.id);
      } catch {
        return this.fallback.comparePair(a, b, context);
      }
    }
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.request({ op: "health" });
      return isRecord(response) && response["ok"] === true;
    } catch {
      return false;
    }
  }

  async restart(): Promise<void> {
    this.stop(new Error("verifier sidecar restarted"));
    this.start();
    if (!(await this.health())) {
      this.stop(new Error("verifier sidecar failed its health check"));
      throw new Error("verifier sidecar is unhealthy after restart");
    }
  }

  close(): void {
    this.stop(new Error("verifier sidecar closed"));
  }

  private start(): void {
    if (this.child !== null) return;
    const child = spawn(this.command, [this.scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      this.handleLine(line);
    });
    child.on("error", (error) => {
      this.failChild(child, error);
    });
    child.on("exit", (code, signal) => {
      this.failChild(child, new Error(`verifier sidecar exited (${String(code ?? signal)})`));
    });
  }

  private request(body: Record<string, unknown>): Promise<unknown> {
    this.start();
    const child = this.child;
    if (child === null || child.stdin.destroyed) {
      return Promise.reject(new Error("verifier sidecar is unavailable"));
    }
    const requestId = ++this.sequence;
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        rejectRequest(new Error("verifier sidecar request timed out"));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer });
      child.stdin.write(`${JSON.stringify({ id: requestId, ...body })}\n`, (error) => {
        if (error === null || error === undefined) return;
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    try {
      const response: unknown = JSON.parse(line);
      if (!isRecord(response) || typeof response["id"] !== "number") return;
      const pending = this.pending.get(response["id"]);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(response["id"]);
      if (response["error"] !== undefined) {
        pending.reject(new Error(protocolError(response["error"])));
      } else {
        pending.resolve(response);
      }
    } catch {
      // Ignore sidecar diagnostics that are not protocol messages.
    }
  }

  private failChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private stop(error: Error): void {
    const child = this.child;
    this.child = null;
    if (child !== null && !child.killed) child.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function decomposeCriteria(task: string | undefined): string[] {
  if (task === undefined || task.trim() === "") {
    return ["correctness", "regression safety", "simplicity"];
  }
  const criteria = task
    .split(/\n|[.;]\s+/)
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion.length > 0)
    .slice(0, 8);
  return criteria.length > 0 ? criteria : ["correctness", "regression safety", "simplicity"];
}

function parseVerdict(value: unknown, aId: string, bId: string): PairwiseVerdict {
  if (!isRecord(value) || typeof value["rationale"] !== "string" || !isRecord(value["scores"])) {
    throw new TypeError("invalid verifier sidecar response");
  }
  const winner = value["winner"];
  if (winner !== null && winner !== aId && winner !== bId) {
    throw new TypeError("sidecar selected an unknown candidate");
  }
  const aScore = value["scores"][aId];
  const bScore = value["scores"][bId];
  if (typeof aScore !== "number" || !Number.isFinite(aScore) || typeof bScore !== "number" || !Number.isFinite(bScore)) {
    throw new TypeError("sidecar scores must be finite numbers");
  }
  return {
    winner,
    rationale: value["rationale"],
    scores: { [aId]: aScore, [bId]: bScore },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "unknown verifier sidecar error";
  }
}
