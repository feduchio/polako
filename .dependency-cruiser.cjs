/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "domain-is-pure",
      comment: "domain/ holds types, schemas and FSM tables only; it must not depend on I/O modules",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { path: "^src/(?!domain/|shared/)" },
    },
    {
      name: "shared-is-leaf",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { path: "^src/(?!shared/)" },
    },
    {
      name: "store-depends-only-on-domain",
      severity: "error",
      from: { path: "^src/store/" },
      to: { path: "^src/(?!store/|domain/|shared/)" },
    },
    {
      name: "project-depends-only-on-domain-sandbox",
      severity: "error",
      from: { path: "^src/project/" },
      to: { path: "^src/(?!project/|domain/|shared/|sandbox/)" },
    },
    {
      name: "providers-behind-broker-interfaces",
      comment: "concrete providers may only see broker interfaces, never engine/agents",
      severity: "error",
      from: { path: "^src/providers/" },
      to: { path: "^src/(?!providers/|broker/|domain/|shared/)" },
    },
    {
      name: "frontends-talk-to-daemon-only",
      comment: "cli/ and mcp/ are thin facades over the daemon RPC; no direct engine access",
      severity: "error",
      from: { path: "^src/(cli|mcp)/" },
      to: { path: "^src/(engine|scheduler|agents|council|verify|findings|convergence|broker|providers|sandbox|intel|context|protocols|project|store)/" },
    },
    {
      name: "engine-depends-only-on-foundation",
      comment: "A5 engine orchestrates domain + store + scheduler only; later blocks widen via new rules",
      severity: "error",
      from: { path: "^src/engine/" },
      to: { path: "^src/(?!engine/|domain/|shared/|store/|scheduler/)" },
    },
    {
      name: "engine-is-not-imported-by-lower-layers",
      severity: "error",
      from: { path: "^src/(?!engine/|daemon/)" },
      to: { path: "^src/engine/" },
    },
    {
      name: "no-orphans",
      severity: "warn",
      from: { orphan: true, pathNot: ["\\.d\\.ts$", "\\.test\\.ts$", "^src/index\\.ts$"] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
