export interface IntelHit {
  path: string;
  line: number;
  text: string;
}

export interface SymbolRef {
  name: string;
  path: string;
  line: number;
  kind?: string;
}

export interface ImpactResult {
  files: string[];
  symbols: string[];
  depth: number;
  stale?: boolean;
}

export interface IntelHealth {
  ok: boolean;
  backend: string;
  /** When CompositeIntel fell back */
  degradedFrom?: string;
  detail?: string;
  stale?: boolean;
}

export interface ImpactQuery {
  symbol?: string;
  files?: readonly string[];
}

/**
 * Workspace-bound repository intelligence. Constructed for one worktree path.
 */
export interface RepositoryIntelligence {
  readonly workspacePath: string;
  prepare(): Promise<void>;
  explore(query: string, limit?: number): Promise<IntelHit[]>;
  symbol(name: string): Promise<SymbolRef[]>;
  callers(name: string): Promise<SymbolRef[]>;
  callees(name: string): Promise<SymbolRef[]>;
  impact(query: ImpactQuery, depth?: number): Promise<ImpactResult>;
  affectedTests(files: readonly string[]): Promise<string[]>;
  refresh(changedFiles: readonly string[]): Promise<void>;
  health(): Promise<IntelHealth>;
}

export interface CodeGraphProbeResult {
  available: boolean;
  version: string | null;
  fts5: boolean;
  reason?: string;
  /** Native backend may be used only when available && fts5 */
  nativeEligible: boolean;
  /** CLI adapter compatibility, based on discovered commands and options. */
  compatible?: boolean;
  /** Additive contract evidence; absent on legacy/custom probe implementations. */
  contract?: CodeGraphContractCapabilities;
  /** Help-discovered argv dialect for the bound binary. */
  dialect?: CodeGraphDialect;
}

export type CodeGraphJsonFlag = "--json" | "-j";

/** Argv fragments for one installed CodeGraph CLI dialect. */
export interface CodeGraphDialect {
  init: readonly string[];
  searchCommand: string;
  /** JSON flag for search/explore; per-command flags below may differ. */
  jsonFlag: CodeGraphJsonFlag | null;
  jsonFlags: {
    search: CodeGraphJsonFlag | null;
    symbol: CodeGraphJsonFlag | null;
    callers: CodeGraphJsonFlag | null;
    callees: CodeGraphJsonFlag | null;
    impact: CodeGraphJsonFlag | null;
    affected: CodeGraphJsonFlag | null;
    refresh: CodeGraphJsonFlag | null;
  };
  limitFlag: "--limit" | "-l" | null;
  symbolCommand: string;
  callersCommand: string;
  calleesCommand: string;
  impactCommand: string;
  impactDepthFlag: "--depth" | "-d" | null;
  impactSymbolFlag: "--symbol" | null;
  impactFileFlag: "--file" | null;
  affectedCommand: string;
  affectedFileFlag: "--file" | null;
  refreshCommand: string;
}

export interface CodeGraphCommandCapability {
  available: boolean;
  options: Record<string, boolean>;
}

export interface CodeGraphContractCapabilities {
  contractVersion: 1;
  helpDiscovered: boolean;
  commands: Record<string, CodeGraphCommandCapability>;
  missing: string[];
  fixtureQuery: "not-run" | "passed" | "failed";
}

export interface CodeGraphContractProbeOptions {
  /** Optional read-only query against a caller-prepared minimal workspace/index. */
  fixtureQuery?: {
    query: string;
    expectedPath?: string;
    limit?: number;
  };
}
