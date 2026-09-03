import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentRunner } from "../agents/runner.js";
import { ModelBroker } from "../broker/broker.js";
import { probeModelCapabilities } from "../broker/capabilityProbe.js";
import { ModelCatalog } from "../broker/catalog.js";
import { costEligibilityFromConfig } from "../broker/costEligibility.js";
import { DEFAULT_ROUTER_POLICY, ModelRouter } from "../broker/router.js";
import { BudgetTracker, QuotaTracker } from "../broker/quota.js";
import { SecretStore } from "../broker/secrets.js";
import type { ProviderAdapter } from "../broker/types.js";
import type { CouncilCompletionClient, CouncilRoleConfigs } from "../council/types.js";
import type { RuntimeEvidence } from "../domain/acceptance.js";
import type { PolishConfig } from "../domain/config.js";
import { emptyFindingCounts, type Checkpoint } from "../domain/checkpoint.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import type { NewEvent } from "../domain/event.js";
import type { RunPhase } from "../domain/run.js";
import type { Task } from "../domain/task.js";
import {
  createComparingDriver,
  createConvergenceDriver,
  createDiscoveringModelsDriver,
  createExecutingDriver,
  createGatingDriver,
  createIntegratingDriver,
  createInterpretingMissionDriver,
  createPlanningDriver,
  createReviewingDriver,
  createValidatingDriver,
  type RunEngine,
} from "../engine/index.js";
import type { PhaseContext, PhaseDriver } from "../engine/types.js";
import { createProviderFromConfig } from "../providers/factory.js";
import type { ReviewProvider } from "../review/swarm.js";
import {
  buildBaselineSnapshot,
  createCheckOutputPersister,
  discoverProject,
  runChecks,
  type ProjectProfile,
} from "../project/index.js";
import type { FinalReportInput } from "../report/reports.js";
import {
  discoverRuntimeValidator,
  discoverProjectRuntime,
  FixtureRuntimeValidator,
  type RuntimeCapabilityMode,
} from "../runtime/index.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import { WorktreeSandbox, type Sandbox } from "../sandbox/worktree.js";
import type { Clock } from "../shared/clock.js";
import { PolishError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import { MissionAcceptanceService, type Store } from "../store/index.js";
import type { FacadeRunMetadata } from "./types.js";
import { parseModelRefString } from "./configLoad.js";

export interface RunBudgetLimits {
  budgetTokens?: number;
  budgetUsd?: number;
}

/** Phases that must use production drivers in the daemon composition (B9). */
export const PRODUCTION_DRIVER_PHASES = [
  "DISCOVERING_PROJECT",
  "BASELINING",
  "INTERPRETING_MISSION",
  "DISCOVERING_MODELS",
  "PLANNING",
  "EXECUTING",
  "GATING",
  "COMPARING",
  "INTEGRATING",
  "REVIEWING",
  "VALIDATING",
  "SIMPLIFYING",
  "CONVERGENCE_CHECK",
] as const satisfies readonly RunPhase[];

export interface ProductionDeps {
  store: Store;
  clock: Clock;
  config: PolishConfig;
  home: string;
  catalog: ModelCatalog;
  broker: ModelBroker;
  router: ModelRouter;
  providers: ProviderAdapter[];
  resolveSandbox?: (ctx: PhaseContext) => Sandbox;
}

export interface BuildProductionDepsOptions {
  store: Store;
  clock: Clock;
  config: PolishConfig;
  home: string;
  providers?: ProviderAdapter[];
  resolveSandbox?: (ctx: PhaseContext) => Sandbox;
}

/** Merge CLI/daemon per-run budget overrides into engine config. */
export function applyRunBudgetOverrides(config: PolishConfig, limits: RunBudgetLimits): PolishConfig {
  return {
    ...config,
    budget: {
      ...config.budget,
      maxRunTokens: limits.budgetTokens ?? config.budget.maxRunTokens,
      maxRunUsd: limits.budgetUsd ?? config.budget.maxRunUsd,
    },
  };
}

export function parseRuntimeMode(value: string): RuntimeCapabilityMode {
  if (value === "auto" || value === "required" || value === "off") return value;
  throw new PolishError("CONFIG_ERROR", "runtime must be one of auto|required|off");
}

export function buildProductionDeps(options: BuildProductionDepsOptions): ProductionDeps {
  const secrets = SecretStore.fromFile(join(options.home, "secrets.env"));
  const catalog = new ModelCatalog();
  const providers = options.providers ?? loadConfiguredProviders(options.config, secrets, options.home);
  for (const provider of providers) catalog.register(provider);
  const broker = new ModelBroker({
    store: options.store,
    clock: options.clock,
    catalog,
    quota: new QuotaTracker(options.clock, { concurrency: options.config.lanes["llm.default"], rpm: null }),
    budget: new BudgetTracker(options.config.budget),
    secrets,
  });
  const sandbox = options.resolveSandbox ?? ((ctx) => new WorktreeSandbox(
    ctx.run.projectPath,
    join(options.home, "worktrees", ctx.run.id),
    options.config.sandbox,
  ));
  return {
    store: options.store,
    clock: options.clock,
    config: options.config,
    home: options.home,
    catalog,
    broker,
    router: new ModelRouter(catalog, {
      ...DEFAULT_ROUTER_POLICY,
      costEligibility: costEligibilityFromConfig(options.config.routing),
    }),
    providers,
    resolveSandbox: sandbox,
  };
}

/**
 * Resolve and optionally execute a project runtime scenario under the requested mode.
 * `required` fails closed when no validator is available.
 */
export async function resolveRuntimeEvidence(input: {
  projectPath: string;
  runId: string;
  mode: RuntimeCapabilityMode;
  missionId: string;
  store: Store;
  clock: Clock;
}): Promise<{ selectionReason: string; evidence: RuntimeEvidence | null }> {
  const discovery = discoverProjectRuntime(input.projectPath);
  if (discovery.templates.length === 0) {
    if (input.mode === "required") {
      throw new PolishError(
        "CONFIG_ERROR",
        "runtime=required but no project runtime scenario was found under runtime/",
        { projectPath: input.projectPath },
      );
    }
    return { selectionReason: discovery.reason, evidence: null };
  }

  const template = discovery.templates[0];
  if (template === undefined) {
    return { selectionReason: discovery.reason, evidence: null };
  }
  const scenario = {
    id: template.id,
    runId: input.runId,
    kind: template.kind,
    fixtureRoot: resolve(input.projectPath),
    script: template.relativeScript,
    checkpointHash: "0".repeat(40),
  };
  const selection = await discoverRuntimeValidator(input.mode, scenario, [new FixtureRuntimeValidator()]);
  if (selection.validator === null) {
    return { selectionReason: selection.reason, evidence: null };
  }
  const evidence = await selection.validator.validate(scenario);
  const corpus = new MissionAcceptanceService(input.store, input.clock);
  corpus.recordRuntimeEvidence({
    missionId: input.missionId,
    requirementRef: "runtime.required_scenario",
    evidence,
    summary: evidence.summary,
  });
  return { selectionReason: selection.reason, evidence };
}

/** Production DISCOVERING_PROJECT: manifest profile + runtime capability recording. */
export function createDiscoveringProjectDriver(_deps: ProductionDeps): PhaseDriver {
  return (ctx) => {
    const discovered = ctx.store.events.list(ctx.run.id, { types: ["project.discovered"] });
    if (discovered.length > 0) return { status: "complete", nextPhase: "BASELINING" };

    const profile = discoverProject(ctx.run.projectPath);
    const runtimeDiscovery = discoverProjectRuntime(ctx.run.projectPath);
    const event: NewEvent = {
      id: id("evt", ctx.clock.now()),
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "project.discovered",
      payload: {
        profile,
        runtimeCapability: runtimeDiscovery.capability,
        runtimeReason: runtimeDiscovery.reason,
        runtimeTemplates: runtimeDiscovery.templates,
      },
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    };
    ctx.store.events.append([event]);
    return { status: "complete", nextPhase: "BASELINING" };
  };
}

/** Production BASELINING: snapshot checks at the run checkpoint without treating PASS as DONE evidence. */
export function createBaseliningDriver(deps: ProductionDeps): PhaseDriver {
  return async (ctx) => {
    if (ctx.store.repos.baselines.listByRun(ctx.run.id).length > 0) {
      return { status: "complete", nextPhase: "INTERPRETING_MISSION" };
    }
    const profile = resolveDiscoveredProfile(ctx);
    const commitHash = ctx.run.currentCheckpointHash;
    if (commitHash === null) return { status: "waiting" };

    const policy = commandPolicyFor(ctx, profile);
    const sandboxBackend = resolveSandbox(deps, ctx);
    const sandbox = await sandboxBackend.create({
      id: `baseline-${ctx.run.id}`,
      baseCommit: commitHash,
      policy,
    });
    try {
      const checks = await runChecks({
        runId: ctx.run.id,
        commitHash,
        sandbox,
        profile,
        persistOutput: createCheckOutputPersister(ctx.store.artifacts),
      });
      const baseline = buildBaselineSnapshot({
        runId: ctx.run.id,
        commitHash,
        checks,
        profile,
      });
      ctx.store.events.append([
        {
          id: id("evt", ctx.clock.now()),
          runId: ctx.run.id,
          ts: ctx.clock.now(),
          type: "baseline.snapshotted",
          payload: { baseline },
          causedBy: [],
          actor: SYSTEM_ACTOR,
          artifacts: [],
        },
      ]);
      patchRun(ctx, {
        baselineId: baseline.id,
        currentCheckpointHash: commitHash,
      });
      return { status: "complete", nextPhase: "INTERPRETING_MISSION" };
    } finally {
      await sandbox.destroy();
    }
  };
}

/**
 * Production SIMPLIFYING: Phase B does not run C1 simplification. Advance to convergence
 * without creating simplify tasks or claiming code changes.
 */
export function createSimplifyingDriver(): PhaseDriver {
  return () => ({ status: "complete", nextPhase: "CONVERGENCE_CHECK" });
}

/** Promote eligible PENDING tasks to READY so EXECUTING can schedule them (B2). */
export function promoteEligibleTasksToReady(ctx: PhaseContext): void {
  const tasks = ctx.store.repos.tasks.listByRun(ctx.run.id);
  const events: NewEvent[] = [];
  for (const task of tasks) {
    if (task.state !== "PENDING" || !dependenciesMet(tasks, task)) continue;
    const ready: Task = { ...task, state: "READY", updatedAt: ctx.clock.now() };
    events.push({
      id: id("evt", ctx.clock.now()),
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "task.state_changed",
      payload: { task: ready, from: "PENDING", to: "READY" },
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    });
  }
  if (events.length > 0) ctx.store.events.append(events);
}

function withReadyPromotion(driver: PhaseDriver): PhaseDriver {
  return async (ctx) => {
    promoteEligibleTasksToReady(ctx);
    const result = await driver(ctx);
    promoteEligibleTasksToReady(ctx);
    return result;
  };
}

/** Install real phase drivers for every Phase B phase on a non-stub engine. */
export function installProductionDrivers(engine: RunEngine, deps: ProductionDeps): void {
  engine.registerPhase("CREATED", () => ({ status: "complete", nextPhase: "DISCOVERING_PROJECT" }));
  const profileResolver = (ctx: PhaseContext) => resolveDiscoveredProfile(ctx);
  const councilRoles = (ctx: PhaseContext) => resolveCouncilRoles(deps, ctx);
  const candidateOptions = {
    sandbox: (ctx: PhaseContext) => resolveSandbox(deps, ctx),
    policy: (ctx: PhaseContext) => commandPolicyFor(ctx, resolveDiscoveredProfile(ctx)),
    workerFactory: (ctx: PhaseContext) => createWorkerFactory(deps, ctx),
    resolveProfile: profileResolver,
    runtimeValidators: [new FixtureRuntimeValidator()],
  };

  engine.registerPhase("DISCOVERING_PROJECT", createDiscoveringProjectDriver(deps));
  engine.registerPhase("BASELINING", createBaseliningDriver(deps));
  engine.registerPhase(
    "INTERPRETING_MISSION",
    createInterpretingMissionDriver({ roles: councilRoles, resolveProfile: profileResolver }),
  );
  engine.registerPhase("DISCOVERING_MODELS", createDiscoveringModelsDriverFromCatalog(deps));
  engine.registerPhase(
    "PLANNING",
    withReadyPromotion(createPlanningDriver({ roles: councilRoles, resolveProfile: profileResolver })),
  );
  engine.registerPhase("EXECUTING", withReadyPromotion(createExecutingDriver(candidateOptions)));
  engine.registerPhase("GATING", createGatingDriver(candidateOptions));
  engine.registerPhase("COMPARING", createComparingDriver());
  engine.registerPhase("INTEGRATING", createIntegratingDriver(candidateOptions));
  engine.registerPhase("REVIEWING", createReviewingDriver({ resolveReviewers: () => selectReviewProviders(deps) }));
  engine.registerPhase("VALIDATING", withReadyPromotion(createValidatingDriver()));
  engine.registerPhase("SIMPLIFYING", createSimplifyingDriver());
  engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver());
}

function createDiscoveringModelsDriverFromCatalog(deps: ProductionDeps): PhaseDriver {
  const pinnedModels = deps.config.supervisors.map((entry) => parseModelRefString(entry.model));
  return async (ctx) => {
    const discovery = await deps.catalog.discover({
      maxProbesPerProvider: deps.config.discovery.maxProbesPerProvider,
      pinnedModels,
      costEligibility: costEligibilityFromConfig(deps.config.routing),
      capabilityProbe: (adapter, model) =>
        probeModelCapabilities(adapter, model, {
          runId: ctx.run.id,
          maxTokens: deps.config.discovery.probeMaxTokens,
          skipHealth: true,
        }),
    });
    const probeEvents: NewEvent[] = discovery.probes.map((probe) => ({
      id: id("evt", ctx.clock.now()),
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "model.probed",
      payload: {
        ref: probe.info.ref,
        available: probe.available,
        checks: probe.checks,
        capabilities: probe.info.capabilities,
        source: probe.info.source,
      },
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    }));
    if (probeEvents.length > 0) ctx.store.events.append(probeEvents);
    const models = deps.catalog.list().map((entry) => entry.info);
    return createDiscoveringModelsDriver(models)(ctx);
  };
}

/** Router-selected reviewers with exact ModelRef; never listModels()[0]. */
export function selectReviewProviders(deps: ProductionDeps): ReviewProvider[] {
  const ranked = deps.router.select({
    role: "reviewer",
    count: deps.config.review.reviewersPerRound,
    requireJson: true,
  });
  if (ranked.length === 0) {
    throw new PolishError("CONFIG_ERROR", "no cost-eligible reviewer models available");
  }
  return ranked.map((row) => {
    const ref = row.entry.info.ref;
    const adapter = deps.catalog.provider(ref.provider) ?? deps.providers.find((provider) => provider.id === ref.provider);
    if (adapter === undefined) {
      throw new PolishError("CONFIG_ERROR", `no provider adapter for review model ${ref.provider}:${ref.model}`);
    }
    return { provider: adapter, model: ref };
  });
}

export function createWorkerFactory(deps: ProductionDeps, ctx: PhaseContext) {
  const ranked = deps.router.select({ role: "worker", count: deps.config.candidates.normal, requireTools: true });
  return (index: number) => {
    const model = ranked[index % Math.max(ranked.length, 1)]?.entry.info.ref ?? {
      provider: deps.providers[0]?.id ?? "scripted",
      model: "default",
    };
    const client = brokerCouncilClient(deps.broker);
    return new AgentRunner({
      complete: (request) => client.complete(request).then((record) => ("response" in record ? record.response : record)),
      artifacts: deps.store.artifacts,
      model,
      commandPolicy: commandPolicyFor(ctx, resolveDiscoveredProfile(ctx)),
      maxTurns: deps.config.agent.maxTurns,
      maxTokens: deps.config.budget.maxTaskTokens ?? 32_000,
      now: () => deps.clock.now(),
    });
  };
}

export function resolveCouncilRoles(deps: ProductionDeps, ctx?: PhaseContext): CouncilRoleConfigs {
  const client = brokerCouncilClient(deps.broker);
  const resolveRole = (
    role: "planner" | "scope_guardian" | "judge",
    routerRole: "supervisor" | "judge",
  ): CouncilRoleConfigs["planner"] => {
    const pinned = deps.config.supervisors.find((entry) => entry.role === role);
    if (pinned !== undefined) {
      const model = parseModelRefString(pinned.model);
      if (ctx !== undefined) recordCouncilRoleProvenance(ctx, role, model, { configSource: "pinned" });
      return { client, model };
    }
    const ranked = deps.router.select({ role: routerRole, count: 1, requireJson: true });
    const entry = ranked[0];
    if (entry === undefined) {
      throw new PolishError("CONFIG_ERROR", `no models available for council role ${role}`);
    }
    const model = entry.entry.info.ref;
    if (ctx !== undefined) {
      recordCouncilRoleProvenance(ctx, role, model, { fallbackReason: `router.select:${routerRole}` });
    }
    return { client, model };
  };
  return {
    planner: resolveRole("planner", "supervisor"),
    scope_guardian: resolveRole("scope_guardian", "supervisor"),
    judge: resolveRole("judge", "judge"),
  };
}

function recordCouncilRoleProvenance(
  ctx: PhaseContext,
  role: "planner" | "scope_guardian" | "judge",
  model: { provider: string; model: string },
  source: { configSource: "pinned" } | { fallbackReason: string },
): void {
  const event: NewEvent = {
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "council.role_resolved",
    payload: {
      role,
      provider: model.provider,
      model: model.model,
      ...source,
    },
    causedBy: [],
    actor: { kind: "supervisor", role: "council" },
    artifacts: [],
  };
  ctx.store.events.append([event]);
}

function brokerCouncilClient(broker: ModelBroker): CouncilCompletionClient {
  return {
    complete: (request) => broker.complete(request).then((record) => ({ response: record.response, eventId: record.eventId })),
  };
}

function resolveDiscoveredProfile(ctx: PhaseContext): ProjectProfile {
  const events = ctx.store.events.list(ctx.run.id, { types: ["project.discovered"] });
  const latest = events.at(-1);
  const payload = latest?.payload as { profile?: ProjectProfile } | undefined;
  if (payload?.profile !== undefined) return payload.profile;
  return discoverProject(ctx.run.projectPath);
}

function commandPolicyFor(ctx: PhaseContext, profile: ProjectProfile): CommandPolicy {
  return CommandPolicy.forProject(
    profile.checks.map((check) => check.command),
    profile.packageManager,
    ctx.config.sandbox.allowArbitraryCommands,
    {
      packageScripts: Object.keys(readPackageScripts(profile.projectPath)),
      search: true,
    },
  );
}

function readPackageScripts(projectPath: string): Record<string, string> {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

function dependenciesMet(tasks: readonly Task[], task: Task): boolean {
  if (task.dependsOn.length === 0) return true;
  return task.dependsOn.every((dependencyId) => tasks.find((item) => item.id === dependencyId)?.state === "INTEGRATED");
}

function patchRun(ctx: PhaseContext, patch: Partial<typeof ctx.run>): void {
  const event: NewEvent = {
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "run.phase_changed",
    payload: { run: { ...ctx.run, ...patch, updatedAt: ctx.clock.now() } },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  };
  ctx.store.events.append([event]);
}

function resolveSandbox(deps: ProductionDeps, ctx: PhaseContext): Sandbox {
  return deps.resolveSandbox?.(ctx) ?? new WorktreeSandbox(
    ctx.run.projectPath,
    join(deps.home, "worktrees", ctx.run.id),
    deps.config.sandbox,
  );
}

export function loadConfiguredProviders(config: PolishConfig, secrets: SecretStore, home: string): ProviderAdapter[] {
  const providers: ProviderAdapter[] = [];
  for (const entry of config.providers) {
    if (!entry.enabled) continue;
    if (entry.kind === "scripted" || entry.kind === "record-replay") {
      const adapter = createProviderFromConfig(entry, "", { home });
      if (adapter !== null) providers.push(adapter);
      continue;
    }
    if (entry.apiKeyEnv === undefined || !secrets.has(entry.apiKeyEnv)) continue;
    const apiKey = secrets.get(entry.apiKeyEnv);
    const adapter = createProviderFromConfig(entry, apiKey, { home });
    if (adapter !== null) providers.push(adapter);
  }
  return providers;
}

/** Build a DONE/NEEDS_HUMAN/FAILED report from run projections and facade metadata. */
export function buildFacadeReportInput(
  run: {
    id: string;
    phase: string;
    control: string;
    currentCheckpointHash: string | null;
    missionId: string;
  },
  store: Store,
  metadata: FacadeRunMetadata,
): FinalReportInput {
  const events = store.events.list(run.id);
  const cleanRounds = store.repos.cleanRounds.listByRun(run.id);
  const findings = store.repos.findings.listByRun(run.id);
  const corpus = store.repos.acceptanceCorpus.forMission(run.missionId);

  const runtimeEntries = corpus.entries.filter((entry) => entry.kind === "runtime_evidence");
  const summary =
    run.phase === "DONE"
      ? `mission completed for ${metadata.projectPath}`
      : run.phase === "NEEDS_HUMAN"
        ? `mission paused for human input (${metadata.projectPath})`
        : `run ended in ${run.phase} (${run.control})`;

  return {
    summary,
    changes: [
      `run branch ${metadata.runBranch}`,
      `baseline ${metadata.baselineCommit}`,
      ...(metadata.appliedAt === null ? ["target branch not yet updated (use polish apply)"] : [`applied at ${new Date(metadata.appliedAt).toISOString()}`]),
    ],
    reasons: [
      metadata.mission.trim() === "" ? "mission text was not supplied at start" : `mission: ${metadata.mission}`,
      `runtime mode: ${metadata.runtime ?? "auto"}`,
      ...(metadata.budgetTokens === undefined ? [] : [`token budget: ${metadata.budgetTokens}`]),
      ...(metadata.budgetUsd === undefined ? [] : [`usd budget: ${metadata.budgetUsd}`]),
    ],
    rejected: events
      .filter((event) => event.type === "finding.status_changed")
      .map((event) => {
        const finding = (event.payload as { finding?: { status?: string; claim?: string } }).finding;
        if (finding?.status !== "REJECTED") return "";
        return finding.claim ?? "rejected finding";
      })
      .filter((line) => line.length > 0),
    checks: [
      ...cleanRounds.map((round) => `clean round ${round.roundIndex} on ${round.checkpointHash.slice(0, 8)}`),
      ...(runtimeEntries.length === 0 ? ["no runtime evidence recorded"] : runtimeEntries.map((entry) => entry.summary)),
    ],
    findings: findings.map((finding) => `${finding.status} ${finding.severity}: ${finding.claim}`),
    validation: [
      ...findings
        .filter((finding) => finding.status === "VALID" || finding.status === "REJECTED" || finding.status === "UNCERTAIN")
        .map((finding) => `${finding.id} → ${finding.status}`),
      ...(findings.length === 0 ? ["no findings required validation"] : []),
    ],
    convergence: [
      `phase ${run.phase}`,
      `checkpoint ${run.currentCheckpointHash ?? "none"}`,
      `${cleanRounds.length} clean round(s) recorded`,
    ],
    evidence: [
      ...events.slice(-8).map((event) => `${event.type}#${event.seq}`),
      ...corpus.entries.map((entry) => `corpus:${entry.kind}:${entry.id}`),
    ],
  };
}

function syntheticCheckpoint(ctx: PhaseContext, hash: string): Checkpoint {
  return {
    id: id("cp", ctx.clock.now()),
    runId: ctx.run.id,
    seq: 0,
    commitHash: hash,
    parentId: null,
    source: "baseline",
    taskId: null,
    evidence: {
      gates: {},
      testsPassed: 0,
      testsFailed: 0,
      testsTotal: 0,
      openValidatedFindings: emptyFindingCounts(),
      diffLinesFromBaseline: 0,
    },
    createdAt: ctx.clock.now(),
  };
}

export { syntheticCheckpoint };
