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
}
