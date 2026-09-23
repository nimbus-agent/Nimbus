import { TOUR_SELECTORS, type TourCandidate, type TourSelectorCtx } from "./tour-selectors.ts";
import type { TourPlan, TourSkip, TourStep, TourStepKind } from "./tour-types.ts";

export const TOUR_PRIORITY = [
  "oncall",
  "why",
  "owners",
  "standup",
  "decisions",
  "glossary",
] as const satisfies readonly TourStepKind[];
// Compile-time totality: a kind missing from TOUR_PRIORITY makes this `never`, which `true` is not assignable to.
type PriorityIsTotal =
  Exclude<TourStepKind, (typeof TOUR_PRIORITY)[number]> extends never ? true : never;
const PRIORITY_IS_TOTAL: PriorityIsTotal = true;
void PRIORITY_IS_TOTAL;

/** The CLI subcommand each kind runs. Total by type. */
const SUBCOMMAND: Readonly<Record<TourStepKind, string>> = {
  why: "why",
  owners: "owners",
  oncall: "oncall",
  standup: "standup",
  decisions: "decisions",
  glossary: "glossary",
};

/**
 * Chars that never need shell quoting on either a POSIX shell or `cmd.exe`/PowerShell — letters,
 * digits, and the punctuation an absolute path or a flag can carry (`._-/\:=+@`). Anything outside
 * this set (a space, `;`, `|`, `&`, a quote, …) gets wrapped in double quotes so the printed
 * `command` line does the SAME thing when pasted as the tour just did, rather than something else.
 */
const BARE_SAFE_RE = /^[A-Za-z0-9._\-/\\:=+@]+$/;

/**
 * The QUOTED form escapes `\` before `"` — order matters: escaping `"` first would double the
 * backslashes that step had just added. Escaping only the quote (the earlier bug) left an arg
 * that ends in a backslash rendering as `"foo\"`, whose closing quote a POSIX shell reads as
 * ESCAPED rather than closing the string, and `a\"b` round-tripped to the wrong value.
 *
 * This is correct for a POSIX shell's double-quote rules specifically. Bounds, stated rather than
 * hidden: inside double quotes a POSIX shell still expands `$(...)` and backticks, so this is
 * display-safe against metacharacters, not against command substitution in a value an owner
 * already controls; `cmd.exe`/PowerShell do not treat `\` as an escape character at all, so a
 * quoted Windows path shows doubled separators there (`C:\\my dir\\x.ts`) — cosmetic, since
 * Windows path resolution tolerates a doubled `\` except as a leading UNC `\\server` prefix, which
 * a doubled ordinary path never produces. The bare-safe path above is untouched either way: an
 * ordinary Windows path with no spaces (`BARE_SAFE_RE`, which already includes `\`) still prints
 * exactly as typed. This line is a DISPLAY string only — what actually runs is `args`, handed to
 * the runner as an argv array and never re-parsed through a shell.
 */
function quoteForDisplay(arg: string): string {
  if (BARE_SAFE_RE.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `command` and `args` come from ONE value here, so the printed line and the executed step cannot drift. */
function renderCommand(kind: TourStepKind, args: readonly string[], demo: boolean): string {
  return [
    "nimbus",
    ...(demo ? ["--demo"] : []),
    SUBCOMMAND[kind],
    ...args.map(quoteForDisplay),
  ].join(" ");
}

/**
 * The ONE place a {@link TourStep} is constructed from a selected candidate. `buildTourPlan`
 * (`nimbus wow`) and the demo seeder (`demo/seed.ts`, always `demo: true`) both go through it, so
 * the `command` line a user is shown and the `args` the runner actually executes are derived from
 * one value on both surfaces and cannot drift apart. `renderCommand` stays private for that
 * reason — a second caller rendering its own line is exactly the drift this prevents.
 */
export function tourStepFor(kind: TourStepKind, candidate: TourCandidate, demo: boolean): TourStep {
  return {
    kind,
    title: candidate.title,
    args: candidate.args,
    reason: candidate.reason,
    command: renderCommand(kind, candidate.args, demo),
  };
}

export async function buildTourPlan(
  ctx: TourSelectorCtx,
  opts: { steps: number; demo: boolean; selectors?: typeof TOUR_SELECTORS },
): Promise<TourPlan> {
  const selectors = opts.selectors ?? TOUR_SELECTORS;
  const candidates: TourStep[] = [];
  const skipped: TourSkip[] = [];
  for (const kind of TOUR_PRIORITY) {
    try {
      const r = await selectors[kind](ctx);
      if ("skip" in r) {
        skipped.push({ kind, reason: r.skip });
      } else {
        candidates.push(tourStepFor(kind, r.ok, opts.demo));
      }
    } catch {
      skipped.push({ kind, reason: "selector error" });
    }
  }
  return {
    steps: candidates.slice(0, opts.steps),
    more: candidates.slice(opts.steps),
    skipped,
    t0: ctx.nowMs,
  };
}
