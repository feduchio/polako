import type {
  ImpactQuery,
  ImpactResult,
  IntelHealth,
  IntelHit,
  RepositoryIntelligence,
  SymbolRef,
} from "./types.js";

export interface CompositeIntelOptions {
  primary: RepositoryIntelligence;
  fallback: RepositoryIntelligence;
  /** Optional label for primary backend in health */
  primaryName?: string;
}

/**
 * Prefers a healthy primary (e.g. CodeGraphCli); degrades to fallback (BasicIntel).
 */
export class CompositeIntel implements RepositoryIntelligence {
  private active: RepositoryIntelligence;
  private degraded = false;
  private readonly primaryName: string;

  constructor(
    readonly workspacePath: string,
    private readonly options: CompositeIntelOptions,
  ) {
    if (options.primary.workspacePath !== workspacePath || options.fallback.workspacePath !== workspacePath) {
      throw new Error("CompositeIntel backends must share workspacePath");
    }
    this.active = options.primary;
    this.primaryName = options.primaryName ?? "primary";
  }

  async prepare(): Promise<void> {
    try {
      await this.options.primary.prepare();
      const h = await this.options.primary.health();
      if (h.ok) {
        this.active = this.options.primary;
        this.degraded = false;
        return;
      }
    } catch {
      /* degrade */
    }
    await this.useFallback();
  }

  private async useFallback(): Promise<void> {
    await this.options.fallback.prepare();
    this.active = this.options.fallback;
    this.degraded = true;
  }

  private async ensureHealthyActive(): Promise<void> {
    if (this.active === this.options.fallback) return;
    try {
      const h = await this.active.health();
      if (h.ok) return;
    } catch {
      /* degrade */
    }
    await this.useFallback();
  }

  private async withFallback<T>(op: (backend: RepositoryIntelligence) => Promise<T>): Promise<T> {
    await this.ensureHealthyActive();
    try {
      return await op(this.active);
    } catch (err) {
      if (this.active === this.options.fallback) throw err;
      await this.useFallback();
      return op(this.active);
    }
  }

  explore(query: string, limit?: number): Promise<IntelHit[]> {
    return this.withFallback((b) => b.explore(query, limit));
  }
  symbol(name: string): Promise<SymbolRef[]> {
    return this.withFallback((b) => b.symbol(name));
  }
  callers(name: string): Promise<SymbolRef[]> {
    return this.withFallback((b) => b.callers(name));
  }
  callees(name: string): Promise<SymbolRef[]> {
    return this.withFallback((b) => b.callees(name));
  }
  impact(query: ImpactQuery, depth?: number): Promise<ImpactResult> {
    return this.withFallback((b) => b.impact(query, depth));
  }
  affectedTests(files: readonly string[]): Promise<string[]> {
    return this.withFallback((b) => b.affectedTests(files));
  }
  refresh(changedFiles: readonly string[]): Promise<void> {
    return this.withFallback((b) => b.refresh(changedFiles));
  }

  async health(): Promise<IntelHealth> {
    await this.ensureHealthyActive();
    const h = await this.active.health();
    if (this.degraded) {
      return {
        ...h,
        backend: h.backend,
        degradedFrom: this.primaryName,
        detail: [h.detail, `degraded from ${this.primaryName}`].filter(Boolean).join("; "),
      };
    }
    return h;
  }
}
