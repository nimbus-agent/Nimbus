/** Wire shape of `iac.driftLatest` (gateway `iac-drift/drift-findings.ts`, IaC drift D2). Read-only; names, never values. */
export interface IacDriftFinding {
  readonly workdir: string;
  readonly checkedAt: number;
  readonly startedBy: "owner_cli" | "schedule";
  readonly status: "drift" | "clean" | "failed" | "busy";
  readonly driftCount: number | null;
  readonly plannedChanges: number | null;
  readonly lines: readonly string[];
  readonly reason?: string;
}

export interface IacDriftLatestResult {
  readonly findings: readonly IacDriftFinding[];
}
