import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { PairwiseJudge } from "./pairwise.js";
import type {
  FrontierSelectOptions,
  FrontierSelection,
  PairwiseContext,
  PairwiseVerdict,
  TournamentCandidate,
  VerifierStrategy,
} from "./strategy.js";

const DEFAULT_SCRIPT = fileURLToPath(new URL("../../sidecars/llm_verifier/main.py", import.meta.url));

const SECRET_ENV = /(_API_KEY$|TOKEN|SECRET|PASSWORD|CREDENTIAL|^AWS_|^GH_|^GITHUB_|^OPENAI|^GEMINI|^GOOGLE|^GROQ|^OPENROUTER|^VERTEX|^ANTHROPIC|^DEEPSEEK)/i;

export interface VerifierSidecarOptions {
  command?: string;
  scriptPath?: string;
  requestTimeoutMs?: number;
  fallback?: VerifierStrategy;
  env?: NodeJS.ProcessEnv;
  repeats?: number;
  granularity?: number;
  pivots?: number;
  configuredCriteria?: string[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface VerifierProvenance {
  backend: "sidecar" | "ts";
  fallback: boolean;
  logprobScheme?: "direct" | "two_stage";
  criteria: string[];
  nComparisons: number;
}

/**
 * JSON-lines verifier transport over a persistent Python child.
 * Crash, timeout, protocol error, unhealthy restart, or missing package ⇒ TS fallback.
 */
export class VerifierAdapter implements VerifierStrategy {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly fallback: VerifierStrategy;
  private readonly command: string;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly repeats: number;
  private readonly granularity: number;
  private readonly pivots: number;
  private readonly configuredCriteria: string[];
  usedFallback = false;
  lastProvenance: VerifierProvenance = { backend: "sidecar", fallback: false, criteria: [], nComparisons: 0 };

  constructor(options: VerifierSidecarOptions = {}) {
    this.scriptPath = options.scriptPath ?? DEFAULT_SCRIPT;
    this.command = options.command ?? defaultPython(this.scriptPath);
    this.timeoutMs = options.requestTimeoutMs ?? 3_000;
    this.fallback = options.fallback ?? new PairwiseJudge();
    this.env = scrubSidecarEnv(options.env);
    this.repeats = options.repeats ?? 2;
    this.granularity = options.granularity ?? 20;
    this.pivots = options.pivots ?? 2;
    this.configuredCriteria = options.configuredCriteria ?? [];
  }

  async comparePair(
    a: TournamentCandidate,
    b: TournamentCandidate,
    context: PairwiseContext,
  ): Promise<PairwiseVerdict> {
    this.usedFallback = false;
    const criteria = this.criteriaFor(context);
    const request = {
      op: "compare",
      candidates: [a, b],
      context,
      criteria,
      n_evaluations: this.repeats,
      granularity: this.granularity,
    };
    try {
      const response = await this.request(request);
      this.lastProvenance = provenanceFrom(false, responseMeta(response, criteria), criteria);
      return parseVerdict(response, a.id, b.id);
    } catch {
      try {
        await this.restart();
        const response = await this.request(request);
        this.lastProvenance = provenanceFrom(false, responseMeta(response, criteria), criteria);
        return parseVerdict(response, a.id, b.id);
      } catch {
        this.usedFallback = true;
        this.lastProvenance = { backend: "sidecar", fallback: true, criteria, nComparisons: 1 };
        return this.fallback.comparePair(a, b, context);
      }
    }
  }

  async selectFrontier(
    candidates: readonly TournamentCandidate[],
    context: PairwiseContext,
    options: FrontierSelectOptions = {},
  ): Promise<FrontierSelection> {
    this.usedFallback = false;
    const criteria = options.criteria ?? this.criteriaFor(context);
    const request = {
      op: "select",
      candidates: [...candidates],
      context,
      criteria,
      n_evaluations: options.repeats ?? this.repeats,
      pivots: options.pivots ?? this.pivots,
      granularity: options.granularity ?? this.granularity,
      on_error: options.onError ?? "raise",
    };
    try {
      return this.selectionFrom(await this.request(request), candidates, criteria, false);
    } catch {
      try {
        await this.restart();
        return this.selectionFrom(await this.request(request), candidates, criteria, false);
      } catch {
        return this.fallbackFrontier(candidates, context, criteria);
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

  private criteriaFor(context: PairwiseContext): string[] {
    return decomposeCriteria(context.task, context.acceptance, this.configuredCriteria);
  }

  private selectionFrom(
    value: unknown,
    candidates: readonly TournamentCandidate[],
    criteria: string[],
    fallback: boolean,
  ): FrontierSelection {
    if (!isRecord(value) || typeof value["rationale"] !== "string" || !isRecord(value["scores"])) {
      throw new TypeError("invalid verifier sidecar select response");
    }
    const ids = new Set(candidates.map((candidate) => candidate.id));
    const winner = value["winner"];
    if (winner !== null && (typeof winner !== "string" || !ids.has(winner))) {
      throw new TypeError("sidecar selected an unknown candidate");
    }
    const ranking = Array.isArray(value["ranking"])
      ? value["ranking"].filter((id): id is string => typeof id === "string" && ids.has(id))
      : [];
    const scores: Record<string, number> = {};
    for (const candidate of candidates) {
      const score = value["scores"][candidate.id];
      if (typeof score !== "number" || !Number.isFinite(score)) {
        throw new TypeError("sidecar scores must be finite numbers");
      }
      scores[candidate.id] = score;
    }
    const nComparisons = typeof value["n_comparisons"] === "number" ? value["n_comparisons"] : 0;
    const logprobScheme = value["logprobScheme"] === "two_stage" || value["logprobScheme"] === "direct"
      ? value["logprobScheme"]
      : undefined;
    const resolvedCriteria = Array.isArray(value["criteria"])
      ? value["criteria"].filter((item): item is string => typeof item === "string")
      : criteria;
    const selection: FrontierSelection = {
      winnerId: typeof winner === "string" ? winner : null,
      ranking: ranking.length > 0 ? ranking : rankedIds(scores),
      scores,
      rationale: value["rationale"],
      method: "ppt",
      fallback,
      criteria: resolvedCriteria,
      nComparisons,
    };
    if (logprobScheme !== undefined) selection.logprobScheme = logprobScheme;
    this.lastProvenance = {
      backend: "sidecar",
      fallback,
      criteria: resolvedCriteria,
      nComparisons,
      ...(logprobScheme === undefined ? {} : { logprobScheme }),
    };
    return selection;
  }

  private async fallbackFrontier(
    candidates: readonly TournamentCandidate[],
    context: PairwiseContext,
    criteria: string[],
  ): Promise<FrontierSelection> {
    this.usedFallback = true;
    const scores: Record<string, number> = Object.fromEntries(candidates.map((candidate) => [candidate.id, 0]));
    let comparisons = 0;
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        if (a === undefined || b === undefined) continue;
        const verdict = await this.fallback.comparePair(a, b, context);
        comparisons++;
        if (verdict.winner === a.id) scores[a.id] = (scores[a.id] ?? 0) + 2;
        else if (verdict.winner === b.id) scores[b.id] = (scores[b.id] ?? 0) + 2;
        else {
          scores[a.id] = (scores[a.id] ?? 0) + 1;
          scores[b.id] = (scores[b.id] ?? 0) + 1;
        }
      }
    }
    const ranking = rankedIds(scores);
    this.lastProvenance = { backend: "sidecar", fallback: true, criteria, nComparisons: comparisons };
    return {
      winnerId: ranking[0] ?? null,
      ranking,
      scores,
      rationale: "Sidecar unavailable; TypeScript pairwise fallback ranked the frontier.",
      method: "pairwise",
      fallback: true,
      criteria,
      nComparisons: comparisons,
    };
  }

  private start(): void {
    if (this.child !== null) return;
    const child = spawn(this.command, [this.scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
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

export function createVerifierStrategy(
  verifier: {
    backend: "ts" | "sidecar";
    repeats: number;
    granularity: number;
    criteria: string[];
    pivotTournamentFrom: number;
  },
  options: VerifierSidecarOptions = {},
): VerifierStrategy {
  const fallback = options.fallback ?? new PairwiseJudge();
  if (verifier.backend === "ts") return fallback;
  return new VerifierAdapter({
    ...options,
    fallback,
    repeats: options.repeats ?? verifier.repeats,
    granularity: options.granularity ?? verifier.granularity,
    configuredCriteria: options.configuredCriteria ?? verifier.criteria,
    pivots: options.pivots ?? 2,
  });
}

export function decomposeCriteria(
  task: string | undefined,
  acceptance?: readonly string[],
  configured?: readonly string[],
): string[] {
  const fromTask = splitCriteria(task);
  const fromAcceptance = (acceptance ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const merged = [...fromTask, ...fromAcceptance].slice(0, 8);
  if (merged.length > 0) return merged;
  const defaults = (configured ?? []).map((item) => item.trim()).filter((item) => item.length > 0).slice(0, 8);
  return defaults.length > 0 ? defaults : ["correctness", "regression safety", "simplicity"];
}

export function defaultPython(scriptPath: string): string {
  const venvPython = join(dirname(scriptPath), ".venv", "bin", "python");
  return existsSync(venvPython) ? venvPython : "python3";
}

export function sidecarScriptPath(): string {
  return DEFAULT_SCRIPT;
}

function splitCriteria(task: string | undefined): string[] {
  if (task === undefined || task.trim() === "") return [];
  return task
    .split(/\n|[.;]\s+/)
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion.length > 0)
    .slice(0, 8);
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

function responseMeta(value: unknown, criteria: string[]): Pick<VerifierProvenance, "logprobScheme" | "nComparisons" | "criteria"> {
  if (!isRecord(value)) return { criteria, nComparisons: 1 };
  const logprobScheme = value["logprobScheme"] === "two_stage" || value["logprobScheme"] === "direct"
    ? value["logprobScheme"]
    : undefined;
  const resolved = Array.isArray(value["criteria"])
    ? value["criteria"].filter((item): item is string => typeof item === "string")
    : criteria;
  return {
    criteria: resolved,
    nComparisons: typeof value["n_comparisons"] === "number" ? value["n_comparisons"] : 1,
    ...(logprobScheme === undefined ? {} : { logprobScheme }),
  };
}

function provenanceFrom(
  fallback: boolean,
  meta: Pick<VerifierProvenance, "logprobScheme" | "nComparisons" | "criteria">,
  criteria: string[],
): VerifierProvenance {
  return {
    backend: "sidecar",
    fallback,
    criteria: meta.criteria.length > 0 ? meta.criteria : criteria,
    nComparisons: meta.nComparisons,
    ...(meta.logprobScheme === undefined ? {} : { logprobScheme: meta.logprobScheme }),
  };
}

function rankedIds(scores: Record<string, number>): string[] {
  return Object.keys(scores).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a.localeCompare(b));
}

function scrubSidecarEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONUNBUFFERED: "1" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_ENV.test(key) || key === "OPENAI_BASE_URL") continue;
    env[key] = value;
  }
  if (extra !== undefined) Object.assign(env, extra);
  return env;
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
