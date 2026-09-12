import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRunner } from "../agents/runner.js";
import { AGENT_TOOL_NAMES } from "../agents/types.js";
import { composeWorkerInstruction, workerPackCap } from "../context/workerInstruction.js";
import { ProtocolRegistry, defaultProtocolsRoot } from "../protocols/loader.js";
import {
  createAuditionStrategyFromConfig,
  ModelAuditioner,
} from "../broker/audition.js";
import { ModelBroker } from "../broker/broker.js";
import { probeModelCapabilities } from "../broker/capabilityProbe.js";
import { ModelCatalog } from "../broker/catalog.js";
import { costEligibilityFromConfig, isCostEligible } from "../broker/costEligibility.js";
import { ModelObservationRepository } from "../broker/observations.js";
import { DEFAULT_ROUTER_POLICY, ModelRouter, type Ranked } from "../broker/router.js";
import type { EnsembleOption } from "../convergence/tracker.js";
import { BudgetTracker, QuotaTracker } from "../broker/quota.js";
import { SecretStore } from "../broker/secrets.js";
import type { ProviderAdapter } from "../broker/types.js";
import { createResilientCouncilClient } from "../council/fallback.js";
import { createStructuredCouncilClient } from "../council/structuredOutput.js";
import type { CouncilCompletionClient, CouncilEventSink, CouncilRoleConfigs } from "../council/types.js";
import type { PolishConfig } from "../domain/config.js";
import { supervisorModelChain } from "../domain/config.js";
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
  recentlyRateLimitedReviewModels,
  createValidatingDriver,
  type DebateCompletionRequest,
  type RunEngine,
} from "../engine/index.js";
import { threeDistinctDebateRoles, type DebateRoles } from "../findings/index.js";
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
  discoverProjectRuntime,
  FixtureRuntimeValidator,
  type RuntimeCapabilityMode,
} from "../runtime/index.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import { WorktreeSandbox, type Sandbox } from "../sandbox/worktree.js";
import type { Clock } from "../shared/clock.js";
import { PolishError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import type { Store } from "../store/index.js";
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
  /** Loaded once: `ProtocolRegistry.load` is synchronous file IO over every protocol directory. */
  protocols: ProtocolRegistry;
  resolveSandbox?: (ctx: PhaseContext) => Sandbox;
  /** A run's own `--budget-tokens` / `--budget-usd`, empty when it has none. */
  resolveRunBudget?: (runId: string) => RunBudgetLimits;
}

export interface BuildProductionDepsOptions {
  store: Store;
  clock: Clock;
  config: PolishConfig;
  home: string;
  providers?: ProviderAdapter[];
  resolveSandbox?: (ctx: PhaseContext) => Sandbox;
  resolveRunBudget?: (runId: string) => RunBudgetLimits;
}

/** True when a run carries neither budget flag, so it uses the daemon-wide limits. */
export function hasNoRunBudget(limits: RunBudgetLimits): boolean {
  return limits.budgetTokens === undefined && limits.budgetUsd === undefined;
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
  const observations = new ModelObservationRepository(options.store, {
    minScoresForRouting: options.config.audition.minScoresForRouting,
  });
  const broker = new ModelBroker({
    store: options.store,
    clock: options.clock,
    catalog,
    quota: new QuotaTracker(options.clock, { concurrency: options.config.lanes["llm.default"], rpm: null }),
    // One resolution of a run's overrides feeds both enforcement surfaces: the tracker here
    // and C2's view through `ctx.config`, which `DaemonService.runConfig` derives the same way.
    budget: new BudgetTracker(options.config.budget, (runId) => {
      const overrides = options.resolveRunBudget?.(runId) ?? {};
      if (hasNoRunBudget(overrides)) return null;
      return applyRunBudgetOverrides(options.config, overrides).budget;
    }),
    secrets,
    observations,
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
    protocols: ProtocolRegistry.load(defaultProtocolsRoot()),
    catalog,
    broker,
    ...(options.resolveRunBudget === undefined ? {} : { resolveRunBudget: options.resolveRunBudget }),
    router: new ModelRouter(catalog, {
      ...DEFAULT_ROUTER_POLICY,
      costEligibility: costEligibilityFromConfig(options.config.routing),
    }),
    providers,
    resolveSandbox: sandbox,
  };
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
        onCheckStart: (info) => {
          recordCheckStart(ctx, info);
        },
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
  const sandboxFor = (ctx: PhaseContext) => resolveSandbox(deps, ctx);
  engine.registerPhase(
    "REVIEWING",
    createReviewingDriver({
      resolveReviewers: (ctx) => selectReviewProviders(deps, ctx),
      sandbox: sandboxFor,
    }),
  );
  engine.registerPhase(
    "VALIDATING",
    withReadyPromotion(
      createValidatingDriver({
        resolveDebateRoles: (ctx) => selectDebateRoles(deps, ctx),
        completeDebate: async (ctx, request) => completeDebateRole(deps, ctx, request),
        sandbox: sandboxFor,
      }),
    ),
  );
  engine.registerPhase("SIMPLIFYING", createSimplifyingDriver());
  engine.registerPhase(
    "CONVERGENCE_CHECK",
    createConvergenceDriver({
      resolveEnsembleAlternatives: (ctx) => resolveEnsembleAlternatives(deps, ctx),
      resolveCliBudget: (ctx) => deps.resolveRunBudget?.(ctx.run.id),
    }),
  );
}

function expectedReviewerQuality(row: Ranked): number {
  return row.entry.stats.quality ?? DEFAULT_ROUTER_POLICY.priorByTier[row.entry.info.capabilities.tier];
}

/**
 * Distinct cost/quality-eligible review ensembles from the same catalog/router REVIEWING uses.
 * Fewer than two ensembles fail closed so CHANGE_ENSEMBLE becomes NEEDS_HUMAN.
 */
export function resolveEnsembleAlternatives(deps: ProductionDeps, ctx?: PhaseContext): EnsembleOption[] {
  const size = deps.config.review.reviewersPerRound;
  const minQuality = deps.config.review.minQualityForRotation;
  const exclude = ctx === undefined ? [] : recentlyRateLimitedReviewModels(ctx);
  const ranked = deps.router.select({
    role: "reviewer",
    count: Math.max(size * 2, 8),
    requireJson: true,
    ...(exclude.length > 0 ? { exclude } : {}),
  });
  const eligible = ranked.filter((row) => expectedReviewerQuality(row) >= minQuality);
  const options: EnsembleOption[] = [];
  for (let offset = 0; offset + size <= eligible.length; offset += size) {
    const slice = eligible.slice(offset, offset + size);
    const qualities = slice.map(expectedReviewerQuality);
    options.push({
      ensemble: slice.map((row) => row.entry.info.ref),
      quality: Math.min(...qualities),
    });
  }
  return options.length >= 2 ? options : [];
}

export function createDiscoveringModelsDriverFromCatalog(deps: ProductionDeps): PhaseDriver {
  const pinnedModels = deps.config.supervisors.flatMap((entry) =>
    supervisorModelChain(entry).map((value) => parseModelRefString(value)),
  );
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
    await runConfiguredAudition(deps, ctx);
    const models = deps.catalog.list().map((entry) => entry.info);
    return createDiscoveringModelsDriver(models)(ctx);
  };
}

function brokerAuditionTransport(broker: ModelBroker) {
  return {
    complete: async (request: Parameters<ModelBroker["complete"]>[0]) => (await broker.complete(request)).response,
  };
}

async function runConfiguredAudition(deps: ProductionDeps, ctx: PhaseContext): Promise<void> {
  const audition = deps.config.audition;
  const strategy = createAuditionStrategyFromConfig(
    audition,
    brokerAuditionTransport(deps.broker),
    ctx.run.id,
  );
  if (!audition.enabled || audition.strategy !== "micro-tasks") return;
  const observations = new ModelObservationRepository(deps.store, {
    minScoresForRouting: audition.minScoresForRouting,
  });
  const policy = costEligibilityFromConfig(deps.config.routing);
  const models = deps.catalog
    .list()
    .filter((entry) => isCostEligible(entry.info.capabilities, policy))
    .map((entry) => entry.info.ref)
    .slice(0, audition.maxModels);
  const tasks = audition.tasks.slice(0, audition.maxTasks).map((task) => ({
    id: task.id,
    prompt: task.prompt,
    ...(task.expected === undefined ? {} : { expected: task.expected }),
  }));
  await new ModelAuditioner(observations, () => ctx.clock.now(), { enabled: audition.enabled }).run(
    models,
    tasks,
    strategy,
  );
  observations.restoreCatalog(deps.catalog);
}

/** Three distinct cost-eligible debate models, or null to skip without inventing a verdict. */
export function selectDebateRoles(deps: ProductionDeps, ctx?: PhaseContext): DebateRoles | null {
  if (deps.catalog.list().length === 0) return null;
  const exclude = ctx === undefined ? [] : recentlyRateLimitedReviewModels(ctx);
  const ranked = deps.router.select({
    role: "reviewer",
    count: 3,
    requireJson: true,
    ...(exclude.length > 0 ? { exclude } : {}),
  });
  if (ranked.length < 3) return null;
  const prosecutor = ranked[0]?.entry.info.ref;
  const defender = ranked[1]?.entry.info.ref;
  const judge = ranked[2]?.entry.info.ref;
  if (prosecutor === undefined || defender === undefined || judge === undefined) return null;
  const roles = { prosecutor, defender, judge };
  return threeDistinctDebateRoles(roles) ? roles : null;
}

async function completeDebateRole(
  deps: ProductionDeps,
  ctx: PhaseContext,
  request: DebateCompletionRequest,
): Promise<string> {
  const record = await deps.broker.complete({
    model: request.model,
    messages: [
      {
        role: "system",
        content:
          request.role === "judge"
            ? 'Judge an evidence-bound finding debate. Return JSON only: {"verdict":"VALID|REJECTED|UNCERTAIN","rationale":"non-empty explanation"}.'
            : `${request.role} in an evidence-bound finding debate. Cite only supplied evidence. Do not invent facts.`,
      },
      { role: "user", content: request.prompt },
    ],
    responseFormat: request.role === "judge" ? "json" : "text",
    temperature: 0,
    metadata: {
      runId: ctx.run.id,
      purpose: "finding_debate",
      role: request.role,
    },
  });
  return record.response.message.content;
}

/** Router-selected reviewers with exact ModelRef; never listModels()[0]. */
export async function selectReviewProviders(deps: ProductionDeps, ctx?: PhaseContext): Promise<ReviewProvider[]> {
  if (deps.catalog.list().length === 0) {
    await deps.catalog.discover({
      costEligibility: costEligibilityFromConfig(deps.config.routing),
    });
  }
  const exclude = ctx === undefined ? [] : recentlyRateLimitedReviewModels(ctx);
  const ranked = deps.router.select({
    role: "reviewer",
    count: Math.max(deps.config.review.reviewersPerRound, 8),
    requireJson: true,
    ...(exclude.length > 0 ? { exclude } : {}),
  });
  if (ranked.length === 0) {
    if (exclude.length > 0) return [];
    throw new PolishError("CONFIG_ERROR", "no cost-eligible reviewer models available");
  }
  return ranked.map((row) => {
    const ref = row.entry.info.ref;
    const adapter = deps.catalog.provider(ref.provider) ?? deps.providers.find((provider) => provider.id === ref.provider);
    if (adapter === undefined) {
      throw new PolishError("CONFIG_ERROR", `no provider adapter for review model ${ref.provider}:${ref.model}`);
    }
    return {
      provider: {
        id: adapter.id,
        kind: adapter.kind,
        concurrency: adapter.concurrency,
        listModels: (signal) => adapter.listModels(signal),
        health: (signal) => adapter.health(signal),
        complete: async (request) => (await deps.broker.complete(request)).response,
      },
      model: ref,
    };
  });
}

export function createWorkerFactory(deps: ProductionDeps, ctx: PhaseContext) {
  const ranked = deps.router.select({ role: "worker", count: deps.config.candidates.normal, requireTools: true });
  const profile = resolveDiscoveredProfile(ctx);
  const maxTokens = deps.config.budget.maxTaskTokens ?? 32_000;
  const maxPackTokens = workerPackCap(maxTokens, deps.config.contextBudget.maxPackTokens);
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
      commandPolicy: commandPolicyFor(ctx, profile),
      maxTurns: deps.config.agent.maxTurns,
      maxTokens,
      // The one seam between a task and what a production worker is told. Item 18 rebinds this
      // rather than unpicking a concatenation.
      prompt: (task) =>
        composeWorkerInstruction({
          registry: deps.protocols,
          task,
          findings: ctx.store.repos.findings.listByRun(ctx.run.id),
          profile,
          tools: [...AGENT_TOOL_NAMES],
          maxPackTokens,
        }),
      now: () => deps.clock.now(),
    });
  };
}

export function resolveCouncilRoles(deps: ProductionDeps, ctx?: PhaseContext): CouncilRoleConfigs {
  const sink: CouncilEventSink = {
    append: (events) => deps.store.events.append([...events]),
  };
  const resolveRole = (
    role: "planner" | "scope_guardian" | "judge",
    routerRole: "supervisor" | "judge",
  ): CouncilRoleConfigs["planner"] => {
    const pinned = deps.config.supervisors.find((entry) => entry.role === role);
    const models =
      pinned !== undefined
        ? supervisorModelChain(pinned).map((value) => parseModelRefString(value))
        : undefined;
    let model;
    let source: { configSource: "pinned" } | { fallbackReason: string };
    if (models?.[0] !== undefined) {
      model = models[0];
      source = { configSource: "pinned" };
    } else {
      const ranked = deps.router.select({ role: routerRole, count: 1, requireJson: true });
      const entry = ranked[0];
      if (entry === undefined) {
        throw new PolishError("CONFIG_ERROR", `no models available for council role ${role}`);
      }
      model = entry.entry.info.ref;
      source = { fallbackReason: `router.select:${routerRole}` };
    }
    const chain = models ?? [model];
    if (ctx !== undefined) recordCouncilRoleProvenance(ctx, role, chain, source);
    const broker = brokerCouncilClient(deps.broker);
    const inner =
      role === "planner"
        ? createStructuredCouncilClient({
            inner: broker,
            role: "planner",
            clock: deps.clock,
            eventSink: sink,
            resolveResponseArtifact: (eventId) => {
              const event = deps.store.events.get(eventId);
              return event?.artifacts.find((artifact) => artifact.kind === "model_response") ?? null;
            },
          })
        : broker;
    const client = createResilientCouncilClient({
      inner,
      models: chain,
      role,
      clock: deps.clock,
      retry: deps.config.council,
      eventSink: sink,
    });
    return { client, model, models: chain };
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
  models: readonly { provider: string; model: string }[],
  source: { configSource: "pinned" } | { fallbackReason: string },
): void {
  const preferred = models[0];
  if (preferred === undefined) return;
  const event: NewEvent = {
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "council.role_resolved",
    payload: {
      role,
      provider: preferred.provider,
      model: preferred.model,
      models: models.map((item) => `${item.provider}:${item.model}`),
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

function recordCheckStart(ctx: PhaseContext, info: { name: string; command: readonly string[] }): void {
  ctx.store.events.append([
    {
      id: id("evt", ctx.clock.now()),
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "shell.command_started",
      payload: { check: info.name, command: info.command },
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    },
  ]);
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
