#!/usr/bin/env node
import type { Event } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { projectRunEconomics, renderRunEconomics } from "../observe/economics.js";
import { projectRunStatus } from "../observe/project.js";
import { renderActivityFeed, renderRunStatus } from "../observe/render.js";
import { BRAND } from "../shared/brand.js";
import { isMainModule } from "../shared/cliEntry.js";
import { registerCards } from "../cards/index.js";
import { loadPolishConfig } from "../daemon/configLoad.js";
import { polishHome } from "../daemon/main.js";
import { loadInstalledModels, renderRolePlan, resolveRolePlan } from "../daemon/rolePlan.js";
import { loadCardSpecs, renderCardPlan, parseOnly, projectOf, readBrief, resolveRunTarget } from "./cards.js";
import { callDaemon } from "./client.js";
import { runWatch } from "./watch.js";

export type CliDaemonCall = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

export async function runCli(
  argv = process.argv.slice(2),
  deps: { callDaemon?: CliDaemonCall } = {},
): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case "project":
      await projectCommand(args);
      return;
    case "run": {
      const mission = flag(args, "--mission");
      // Not defaulted here: an omitted flag has to reach the daemon as omitted, or
      // `polish.toml`'s `runtimeValidation.mode` can never take effect.
      const runtime = flag(args, "--runtime");
      if (runtime !== undefined && runtime !== "auto" && runtime !== "required" && runtime !== "off") {
        throw new Error("--runtime must be one of auto|required|off");
      }
      const budgetTokens = flag(args, "--budget-tokens");
      const budgetUsd = flag(args, "--budget-usd");
      const json = args.includes("--json");
      const requestedDetach = args.includes("--detach") || args.includes("-d");
      const attach = shouldAttachRunObserver({
        detach: requestedDetach,
        json,
        stdoutIsTTY: process.stdout.isTTY,
      });
      const positional = withoutFlags(args, ["--mission", "--runtime", "--budget-tokens", "--budget-usd", "--brief", "--only"]);
      const target = resolveRunTarget(positional, mission);
      const cards = target.cardSpecs.length === 0 ? undefined : loadCardSpecs(target.cardSpecs);
      const only = parseOnly(flag(args, "--only"));
      const brief = readBrief(flag(args, "--brief"));
      if (cards === undefined && (only !== undefined || brief !== undefined)) {
        throw new Error("--only and --brief apply to task cards: pass a card file, directory or glob");
      }
      if (args.includes("--dry-run")) {
        if (cards === undefined) throw new Error("--dry-run applies to task cards: pass a card file, directory or glob");
        process.stdout.write(renderCardPlan(registerCards(cards, { ...(only === undefined ? {} : { only }) })));
        // Which model each role resolves to under this config, from `lms ls` alone: no model server is contacted.
        const config = loadPolishConfig(polishHome());
        process.stdout.write(`\n${renderRolePlan(resolveRolePlan(config, await loadInstalledModels(config)))}`);
        return;
      }
      const run = await (deps.callDaemon ?? callDaemon)<Run>("run", {
        project: projectOf(target),
        mission: target.mission,
        ...(cards === undefined ? {} : { cards }),
        ...(only === undefined ? {} : { only }),
        ...brief,
        ...(runtime === undefined ? {} : { runtime }),
        ...(budgetTokens === undefined ? {} : { budgetTokens: positiveInteger(budgetTokens, "--budget-tokens") }),
        ...(budgetUsd === undefined ? {} : { budgetUsd: Number(budgetUsd) }),
      });
      if (!attach) {
        print(run);
        return;
      }
      const reason = await runWatch({
        runId: run.id,
        json: false,
        verbose: false,
        color: process.env["NO_COLOR"] === undefined && process.stdout.isTTY,
        isTTY: true,
      });
      if (reason === "detached") {
        process.stderr.write(`Observing detached. Run continues as ${run.id}.\nReattach: ${BRAND.cli} watch ${run.id}\n`);
      }
      return;
    }
    case "status":
      await statusCommand(args);
      return;
    case "watch":
      await watchCommand(args);
      return;
    case "log":
      await logCommand(args);
      return;
    case "diff":
      process.stdout.write(`${await callDaemon<string>("diff", runId(withoutBooleanFlags(args)))}\n`);
      return;
    case "cost":
      await costCommand(args, deps.callDaemon ?? callDaemon);
      return;
    case "benchmark-review":
      await benchmarkReviewCommand(args, deps.callDaemon ?? callDaemon);
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

async function costCommand(args: string[], daemonCall: CliDaemonCall): Promise<void> {
  const json = args.includes("--json");
  const id = required(args.find((arg) => !arg.startsWith("-")), "run id");
  const run = await daemonCall<Run>("status", { runId: id });
  const events = await daemonCall<Event[]>("log", { runId: id, afterSeq: -1 });
  const report = projectRunEconomics(run, events);
  if (json) {
    print(report);
    return;
  }
  process.stdout.write(renderRunEconomics(report));
}

async function benchmarkReviewCommand(args: string[], daemonCall: CliDaemonCall): Promise<void> {
  const json = args.includes("--json");
  const liveAbort = args.includes("--live-abort");
  const seedValue = flag(args, "--seed");
  const seed = seedValue === undefined ? 42 : positiveInteger(seedValue, "--seed");
  const transportValue = flag(args, "--transport") ?? "strict";
  if (transportValue !== "strict" && transportValue !== "legacy") {
    throw new Error("--transport must be strict|legacy");
  }
  const configuration = flag(args, "--configuration") ?? "original";
  if (configuration !== "original" && configuration !== "operational") {
    throw new Error("--configuration must be original|operational");
  }
  const result = await daemonCall<{
    summary: string;
    report: unknown;
    artifacts: unknown;
  }>("benchmark.review", { seed, liveAbort, transport: transportValue, configuration });
  if (json) {
    print(result);
    return;
  }
  process.stdout.write(result.summary);
}

async function projectCommand(args: string[]): Promise<void> {
  if (args[0] !== "add") throw new Error(`usage: ${BRAND.cli} project add [path] [--name name]`);
  const rest = args.slice(1);
  const name = flag(rest, "--name");
  const positional = withoutFlags(rest, ["--name"]);
  print(await callDaemon("project.add", {
    path: positional[0] ?? process.cwd(),
    ...(name === undefined ? {} : { name }),
  }));
}

async function statusCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const id = args.find((arg) => !arg.startsWith("-"));
  const result = await callDaemon<Run | Run[]>("status", id === undefined ? {} : { runId: id });
  if (Array.isArray(result)) {
    if (json) {
      print(result);
      return;
    }
    if (result.length === 0) {
      process.stdout.write("No runs.\n");
      return;
    }
    for (const run of result) {
      process.stdout.write(`${run.id}  ${run.phase} / ${run.control}  ${run.projectPath}\n`);
    }
    return;
  }
  const events = await callDaemon<Event[]>("log", { runId: result.id, afterSeq: -1 });
  const view = projectRunStatus(result, events, Date.now());
  if (json) {
    print(view);
    return;
  }
  process.stdout.write(renderRunStatus(view));
}

async function watchCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const verbose = args.includes("--verbose");
  const plain = args.includes("--plain");
  const noColor = args.includes("--no-color") || process.env["NO_COLOR"] !== undefined;
  const id = required(args.find((arg) => !arg.startsWith("-")), "run id");
  const reason = await runWatch({
    runId: id,
    json,
    verbose,
    plain,
    color: !noColor && process.stdout.isTTY,
    isTTY: process.stdout.isTTY && !json && !plain,
  });
  if (reason === "detached") {
    process.stderr.write(`Observing detached. Run continues as ${id}.\nReattach: ${BRAND.cli} watch ${id}\n`);
  }
}

export function shouldAttachRunObserver(input: { detach: boolean; json: boolean; stdoutIsTTY: boolean | undefined }): boolean {
  return input.stdoutIsTTY === true && !input.detach && !input.json;
}

async function logCommand(args: string[]): Promise<void> {
  const follow = args.includes("--follow") || args.includes("-f");
  const json = args.includes("--json");
  const id = required(args.find((arg) => !arg.startsWith("-")), "run id");
  let afterSeq = -1;
  for (;;) {
    const events = await callDaemon<Event[]>("log", { runId: id, afterSeq });
    if (json) {
      for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
    } else {
      const body = renderActivityFeed(events);
      if (body.length > 0) process.stdout.write(`${body}\n`);
    }
    for (const event of events) afterSeq = Math.max(afterSeq, event.seq);
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

function runId(args: string[]): { runId: string } {
  return { runId: required(args.find((arg) => !arg.startsWith("-")), "run id") };
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

function withoutBooleanFlags(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith("-"));
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const usage = `Usage:
  ${BRAND.cli} project add [path] [--name name]
  ${BRAND.cli} run [project] [mission] [--mission text] [--runtime auto|required|off] [--budget-tokens n] [--budget-usd n] [--detach|-d] [--json]
  ${BRAND.cli} run [project] <cards> [--brief file] [--only id,id] [--dry-run] [--detach|-d] [--json]   cards: a .md file, a directory of cards, or a glob
  ${BRAND.cli} status [run-id] [--json]            (a card run lists every card's state)
  ${BRAND.cli} watch <run-id> [--verbose] [--json] [--plain] [--no-color]
  ${BRAND.cli} log <run-id> [--follow] [--json]
  ${BRAND.cli} cost <run-id> [--json]
  ${BRAND.cli} benchmark-review [--seed n] [--transport strict|legacy] [--configuration original|operational] [--live-abort] [--json]
  ${BRAND.cli} diff <run-id>
  ${BRAND.cli} pause|resume|stop|kill <run-id>
  ${BRAND.cli} answer <run-id> <answer>
  ${BRAND.cli} apply <run-id>

Everyday use (after install):
  ${BRAND.cli} run [project] --mission "..."

Development install/update only (from the polako repo, Node >= 24):
  pnpm cli:link
`;

if (isMainModule(import.meta.url)) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
