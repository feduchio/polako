#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import type { Event } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { callDaemon } from "./client.js";

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case "project":
      await projectCommand(args);
      return;
    case "run": {
      const mission = flag(args, "--mission");
      const runtime = flag(args, "--runtime") ?? "auto";
      if (runtime !== "auto" && runtime !== "required" && runtime !== "off") {
        throw new Error("--runtime must be one of auto|required|off");
      }
      const budgetTokens = flag(args, "--budget-tokens");
      const budgetUsd = flag(args, "--budget-usd");
      const positional = withoutFlags(args, ["--mission", "--runtime", "--budget-tokens", "--budget-usd"]);
      print(await callDaemon("run", {
        project: positional[0] ?? process.cwd(),
        mission: mission ?? positional.slice(1).join(" "),
        runtime,
        ...(budgetTokens === undefined ? {} : { budgetTokens: positiveInteger(budgetTokens, "--budget-tokens") }),
        ...(budgetUsd === undefined ? {} : { budgetUsd: Number(budgetUsd) }),
      }));
      return;
    }
    case "status":
      print(await callDaemon("status", optionalRunId(args)));
      return;
    case "log":
      await logCommand(args);
      return;
    case "diff":
      process.stdout.write(`${await callDaemon<string>("diff", runId(args))}\n`);
      return;
    case "pause":
    case "resume":
    case "stop":
    case "kill":
      print(await callDaemon(command, runId(args)));
      return;
    case "answer":
      print(await callDaemon("answer", {
        runId: required(args[0], "run id"),
        answer: required(args.slice(1).join(" "), "answer"),
      }));
      return;
    case "apply":
      print(await callDaemon("apply", runId(args)));
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(usage);
      return;
    default:
      throw new Error(`unknown command ${command}\n${usage}`);
  }
}

async function projectCommand(args: string[]): Promise<void> {
  if (args[0] !== "add") throw new Error("usage: polish project add [path] [--name name]");
  const rest = args.slice(1);
  const name = flag(rest, "--name");
  const positional = withoutFlags(rest, ["--name"]);
  print(await callDaemon("project.add", {
    path: positional[0] ?? process.cwd(),
    ...(name === undefined ? {} : { name }),
  }));
}

async function logCommand(args: string[]): Promise<void> {
  const follow = args.includes("--follow") || args.includes("-f");
  const id = required(args.find((arg) => !arg.startsWith("-")), "run id");
  let afterSeq = -1;
  for (;;) {
    const events = await callDaemon<Event[]>("log", { runId: id, afterSeq });
    for (const event of events) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      afterSeq = Math.max(afterSeq, event.seq);
    }
    if (!follow) return;
    const run = await callDaemon<Run>("status", { runId: id });
    if (isSettled(run)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

function isSettled(run: Run): boolean {
  return ["DONE", "NEEDS_HUMAN", "FAILED"].includes(run.phase) ||
    run.control === "STOPPED" || run.control === "KILLED";
}

function optionalRunId(args: string[]): Record<string, unknown> {
  return args[0] === undefined ? {} : { runId: args[0] };
}

function runId(args: string[]): { runId: string } {
  return { runId: required(args[0], "run id") };
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value === "") throw new Error(`${label} is required`);
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : required(args[index + 1], `${name} value`);
}

function withoutFlags(args: string[], valueFlags: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (valueFlags.includes(arg)) {
      index++;
    } else if (!arg.startsWith("-")) {
      values.push(arg);
    }
  }
  return values;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const usage = `Usage:
  polish project add [path] [--name name]
  polish run [project] [mission] [--mission text] [--runtime auto|required|off] [--budget-tokens n] [--budget-usd n]
  polish status [run-id]
  polish log <run-id> [--follow]
  polish diff <run-id>
  polish pause|resume|stop|kill <run-id>
  polish answer <run-id> <answer>
  polish apply <run-id>
`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
