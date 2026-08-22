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
