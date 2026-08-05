// scripts/typecheck-tests/toolchain.ts

/** One `tsc --noEmit -p <project>` invocation and what it produced. */
export interface ProjectRun {
  readonly project: string;
  readonly exitCode: number;
  /** Number of `file(line,col): error TSxxxx:` diagnostics parsed out of this project's output. */
  readonly errorCount: number;
  /** Combined stdout+stderr, kept verbatim so an unrunnable project can print its own cause. */
  readonly output: string;
}

/**
 * A gate whose ONLY signal is "did the regex match anything" cannot tell a clean project from a
 * toolchain that never ran: `tsc` fails with a bare, file-less diagnostic in every one of these
 * cases — TS18003 (`include` matched no files), TS5058 (`-p` path does not exist), a missing or
 * unresolvable `typescript`. All three parse to zero errors, which the count alone reads as green.
 *
 * So gate on the RELATIONSHIP between the process exit code and the parsed diagnostics instead:
 *   exit 0  => the project MUST contribute exactly 0 parsed errors
 *   exit !=0 => the project MUST contribute at least 1 parsed error
 * Any other combination means tsc did not do the work we asked for, and is a hard failure — never
 * a pass and never a baseline write.
 *
 * `assertDidWork` (scripts/lib/assert-work.ts) is the sibling primitive for this idea but does not
 * fit here: it greps a tool's own "N files processed" wording, and `tsc` prints no such count under
 * any flag. The exit-code relationship is the same guarantee derived from a signal tsc actually
 * emits, with no output wording to drift on upgrade.
 */
export function ranSuccessfully(run: Pick<ProjectRun, "exitCode" | "errorCount">): boolean {
  return run.exitCode === 0 ? run.errorCount === 0 : run.errorCount > 0;
}

export function unrunnableReport(run: ProjectRun): string {
  const expectation =
    run.exitCode === 0
      ? "exited 0 but produced parsed diagnostics"
      : `exited ${String(run.exitCode)} but produced NO parseable "file(line,col): error TSxxxx:" diagnostic`;
  return [
    `typecheck-tests: tsc did not run for ${run.project} — ${expectation}.`,
    `  tsc exit code: ${String(run.exitCode)}`,
    `  parsed errors: ${String(run.errorCount)}`,
    "  tsc output:",
    run.output.trim() === "" ? "    (no output)" : indent(run.output.trimEnd()),
  ].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}
