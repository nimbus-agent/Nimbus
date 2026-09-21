import { runDecisionsCommand } from "../commands/decisions.ts";
import { runGlossaryCommand } from "../commands/glossary.ts";
import { runOncallCommand } from "../commands/oncall.ts";
import { runOwnersCommand } from "../commands/owners.ts";
import { runStandupCommand } from "../commands/standup.ts";
import { runWhyCli } from "../commands/why.ts";
import { CliExit } from "./cli-exit.ts";

/**
 * Structural mirror of the gateway's `agents/_lib/tour-types.ts` — the CLI cannot import
 * gateway source (dependency rule), so this file re-declares the wire shape field-for-field
 * rather than importing it.
 */
export type TourStepKind = "why" | "owners" | "oncall" | "standup" | "decisions" | "glossary";

export interface TourStep {
  readonly kind: TourStepKind;
  readonly title: string;
  /** Display only. May carry `--demo`. */
  readonly command: string;
  /** The clean subcommand argv handed to the runner. NEVER contains `--demo`. */
  readonly args: readonly string[];
  readonly reason: string;
}

export type TourRunners = Readonly<Record<TourStepKind, (args: string[]) => Promise<void>>>;

export interface TourStepResult {
  readonly kind: TourStepKind;
  readonly ok: boolean;
}

/**
 * The single rule-line shape both `tourHeader` (a full step banner) and `nimbus wow`'s own panel
 * header (a rule line with no `$ command` beneath it) render from — kept in one function so the
 * two cannot drift apart.
 */
export function tourRule(n: number, total: number, title: string): string {
  const lead = `── [${String(n)}/${String(total)}] ${title} `;
  return lead.padEnd(56, "─");
}

/**
 * `demo.ts`'s `header()` generalised with an explicit `total`: the tour's own proof panel is
 * step `steps.length + 1` of a total the header text itself has no other way to know.
 */
export function tourHeader(n: number, total: number, title: string, command: string): string {
  return `\n${tourRule(n, total, title)}\n$ ${command}\n`;
}

/**
 * Runs `steps` in order through `runners`, printing a header for each via `out` before it runs.
 * One step throwing, or leaving a non-zero `process.exitCode` behind, marks that step `ok:
 * false` and moves on — it never stops the loop and never leaks onto the process the next step
 * (or the caller) sees. A thrown `CliExit` already printed its own message at the throw site, so
 * only an ordinary `Error` (or a non-`Error` throw) is additionally reported via `err`. The plan
 * arrives from the gateway over IPC, so `TourStepKind` is only a compile-time claim about it — a
 * `step.kind` with no matching runner is reported and skipped rather than thrown out of the loop.
 *
 * `process.exitCode` restore, per step, is `before ?? 0` rather than `before`: Bun's own
 * `exitCode` setter silently ignores a later `undefined`/`null` assignment once a real number has
 * been set (Node.js resets it; Bun keeps the old value), and `0` and `undefined` are equivalent at
 * actual process exit — so `?? 0` is the one value that reliably lands regardless of what ambient
 * state a step started from, where a bare `= before` would sometimes silently no-op.
 */
export async function runTour(
  steps: readonly TourStep[],
  runners: TourRunners,
  out: (s: string) => void,
  err: (s: string) => void,
  total: number,
): Promise<TourStepResult[]> {
  const results: TourStepResult[] = [];
  for (const [i, step] of steps.entries()) {
    out(tourHeader(i + 1, total, step.title, step.command));
    const runner = runners[step.kind];
    if (!Object.hasOwn(runners, step.kind) || typeof runner !== "function") {
      err(`unknown tour step kind: ${String(step.kind)}\n`);
      results.push({ kind: step.kind, ok: false });
      continue;
    }
    const before = process.exitCode;
    let ok: boolean;
    try {
      await runner([...step.args]);
      ok = (process.exitCode ?? 0) === 0 || (process.exitCode ?? 0) === (before ?? 0);
    } catch (error) {
      ok = false;
      if (!(error instanceof CliExit)) {
        err(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    } finally {
      process.exitCode = before ?? 0;
    }
    results.push({ kind: step.kind, ok });
  }
  return results;
}

/** Wired to the real agent-brief CLI commands `nimbus wow` composes its tour from. */
export const defaultTourRunners: TourRunners = {
  why: runWhyCli,
  owners: runOwnersCommand,
  oncall: runOncallCommand,
  standup: runStandupCommand,
  decisions: runDecisionsCommand,
  glossary: runGlossaryCommand,
};
