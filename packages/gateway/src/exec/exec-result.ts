/**
 * DECLARATION-ONLY. Do not add runtime logic to this file.
 *
 * It is coverage-exempt by exact path (`scripts/coverage-floor/exclusions.ts`) because a file with
 * no executable statement emits no lcov record, reads as 0%, and can never rejoin the floor. The
 * moment a function or constant lands here that exemption becomes a hole rather than an accounting
 * fact — put such code in `exec-run.ts` or `exec-gate.ts`, which are gated normally.
 */

/**
 * Why the child stopped.
 *
 * `truncated` alone cannot distinguish these -- a run can hit the output cap, or be stopped by the
 * wall clock part-way through a write -- which is why this field exists alongside it. The CLI maps
 * it to distinct exit codes so a wrapper script can tell the two apart.
 */
export type TerminationReason = "exited" | "output_cap" | "wall_clock";

export interface ExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly terminationReason: TerminationReason;
}
