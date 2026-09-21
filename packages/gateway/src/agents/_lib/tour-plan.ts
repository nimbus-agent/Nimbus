import { TOUR_SELECTORS, type TourSelectorCtx } from "./tour-selectors.ts";
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

function quoteForDisplay(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
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
        candidates.push({
          kind,
          title: r.ok.title,
          args: r.ok.args,
          reason: r.ok.reason,
          command: renderCommand(kind, r.ok.args, opts.demo),
        });
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
