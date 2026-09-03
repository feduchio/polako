export interface FacadeRunMetadata {
  runId: string;
  projectPath: string;
  mission: string;
  baselineCommit: string;
  targetBranch: string;
  runBranch: string;
  reportPath: string;
  appliedAt: number | null;
  runtime?: string;
  budgetTokens?: number;
  budgetUsd?: number;
  runtimeSelectionReason?: string;
  runtimeEvidenceId?: string;
}
