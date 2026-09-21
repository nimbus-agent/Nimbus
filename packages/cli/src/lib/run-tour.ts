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
 * `demo.ts`'s `header()` generalised with an explicit `total`: the tour's own proof panel is
 * step `steps.length + 1` of a total the header text itself has no other way to know.
 */
export function tourHeader(n: number, total: number, title: string, command: string): string {
  const lead = `── [${String(n)}/${String(total)}] ${title} `;
  return `\n${lead.padEnd(56, "─")}\n$ ${command}\n`;
}

interface StepOutcome {
  readonly ok: boolean;
  readonly threw: boolean;
  readonly error: unknown;
}

/**
 * Runs one step's runner with `process.exitCode` isolated on a local shadow, so nothing the
 * runner does to it is ever visible on the real global — not during the call, and not
 * afterwards.
 *
 * This is not a style choice; it works around a genuine Bun runtime gap. Once
 * `process.exitCode` has been assigned a real number, Bun's own setter silently ignores a
 * later `undefined`/`null` assignment and keeps the old value (Node.js, by contrast, really
 * does reset it — see the neighbourhood of https://github.com/oven-sh/bun/issues/6284;
 * confirmed here against Bun 1.3.14: `process.exitCode = 2; process.exitCode = undefined;`
 * leaves `process.exitCode` at `2`). A naive "snapshot, then `process.exitCode = snapshot` in
 * `finally`" cannot reset a step's exit code back to `undefined` for exactly that reason, and a
 * tour whose second step's failure silently became the THIRD step's (or the whole process's)
 * exit code would be worse than no isolation at all.
 *
 * The fix swaps `globalThis.process` for a `Proxy` for the duration of the call. `process` is
 * an ordinary writable, configurable global binding (unlike the `exitCode` property on it,
 * which is a non-configurable accessor), so every runner here — none of which imports
 * `node:process` or caches a `process` reference at module load — resolves the bare identifier
 * `process` through the swapped global and reads/writes `exitCode` against the shadow instead
 * of the real object. Every other property forwards straight through to the real `process` via
 * `Reflect`, so `process.stdout.write`, `process.env`, etc. are unaffected. Because the real
 * object's own `exitCode` is never actually written during the call, restoring
 * `globalThis.process` afterwards leaves it exactly where it started — there is nothing left to
 * "reset".
 */
async function runIsolated(
  runner: (args: string[]) => Promise<void>,
  args: readonly string[],
): Promise<StepOutcome> {
  const real = globalThis.process;
  const before = real.exitCode;
  let shadow: typeof real.exitCode = before;

  const proxy = new Proxy(real, {
    get(target, prop) {
      return prop === "exitCode" ? shadow : Reflect.get(target, prop, target);
    },
    set(target, prop, value) {
      if (prop === "exitCode") {
        shadow = value as typeof real.exitCode;
        return true;
      }
      return Reflect.set(target, prop, value, target);
    },
  });

  (globalThis as typeof globalThis & { process: typeof process }).process = proxy;
  try {
    await runner([...args]);
    return { ok: shadow === before || shadow === 0, threw: false, error: undefined };
  } catch (error) {
    return { ok: false, threw: true, error };
  } finally {
    (globalThis as typeof globalThis & { process: typeof process }).process = real;
    // Defensive only: `real.exitCode` was never actually mutated above, so this is always a
    // same-value no-op. Kept so the restore is visible at this call site rather than resting
    // entirely on the Proxy never having forwarded a write.
    real.exitCode = before;
  }
}

/**
 * Runs `steps` in order through `runners`, printing a header for each via `out` before it runs.
 * One step throwing, or leaving a non-zero `process.exitCode` behind, marks that step `ok:
 * false` and moves on — it never stops the loop and never leaks onto the process the next step
 * (or the caller) sees. A thrown `CliExit` already printed its own message at the throw site, so
 * only an ordinary `Error` (or a non-`Error` throw) is additionally reported via `err`.
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
    const outcome = await runIsolated(runners[step.kind], step.args);
    if (outcome.threw && !(outcome.error instanceof CliExit)) {
      err(`${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}\n`);
    }
    results.push({ kind: step.kind, ok: outcome.ok });
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
