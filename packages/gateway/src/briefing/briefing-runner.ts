import type { BriefingBrief } from "../agents/_lib/briefing-types.ts";
import { synthesize } from "../agents/_lib/synthesize.ts";
import { type BriefingDeliveryDeps, deliverBriefing } from "./briefing-delivery.ts";
import { type BriefingFiredBy, type BriefingStore, SlotTakenError } from "./briefing-store.ts";
import { briefingToastText } from "./briefing-toast.ts";

/**
 * Composes one briefing and delivers it locally. The brief is rendered DETERMINISTICALLY: `synthesize` is
 * called with its single argument (OR-10-8), so no model is ever consulted and nothing leaves the machine.
 *
 * Order inside one fire: build, render, INSERT the `briefing_run` row (the claim; the unique `slot_at`
 * index makes a double fire impossible), emit `briefing.ready`, toast, store the toast outcome. A throw
 * while building or rendering stores a `failed` row and emits nothing.
 */
export type BriefingRunnerDeps = BriefingDeliveryDeps & {
  readonly store: BriefingStore;
  readonly now: () => number;
  /** Builds the brief for the instant it is given (the runtime closes over the db and the config). */
  readonly build: (nowMs: number) => BriefingBrief;
  readonly retentionDays: () => number;
  readonly onError?: (err: unknown) => void;
};

export type BriefingRunRequest = {
  readonly firedBy: BriefingFiredBy;
  /** The scheduled instant this run answers; absent for a manual run. */
  readonly slotAt?: number;
  /** False on a demo-rooted gateway: the event is still emitted, no toast is shown. */
  readonly toast: boolean;
};

export type BriefingRunResult = {
  readonly id: string;
  readonly status: "ok" | "failed";
  readonly headline: string;
};

const FAILED_HEADLINE = "The briefing could not be composed";
const ERROR_MESSAGE_MAX = 200;
const DAY_MS = 86_400_000;

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message.slice(0, ERROR_MESSAGE_MAX)}`;
  return `Error: ${String(e).slice(0, ERROR_MESSAGE_MAX)}`;
}

function slotOf(req: BriefingRunRequest): { slotAt: number } | Record<string, never> {
  return req.slotAt === undefined ? {} : { slotAt: req.slotAt };
}

async function compose(
  deps: BriefingRunnerDeps,
  nowMs: number,
): Promise<{ brief: BriefingBrief; markdown: string }> {
  const brief = deps.build(nowMs);
  // NO second argument: without options, `synthesize` returns the deterministic render (OR-10-8).
  const out = await synthesize(brief);
  return { brief, markdown: out.markdown };
}

function prune(deps: BriefingRunnerDeps, nowMs: number): void {
  try {
    deps.store.pruneRuns(nowMs - deps.retentionDays() * DAY_MS);
  } catch (e) {
    deps.onError?.(e);
  }
}

/** Returns `null` when the slot already has a row (another tick claimed it): nothing is emitted or shown. */
export async function runBriefing(
  deps: BriefingRunnerDeps,
  req: BriefingRunRequest,
): Promise<BriefingRunResult | null> {
  const nowMs = deps.now();
  let composed: { brief: BriefingBrief; markdown: string };
  try {
    composed = await compose(deps, nowMs);
  } catch (e) {
    deps.onError?.(e);
    try {
      const id = deps.store.insertRun({
        firedAt: nowMs,
        firedBy: req.firedBy,
        status: "failed",
        headline: FAILED_HEADLINE,
        errorMsg: describeError(e),
        ...slotOf(req),
      });
      prune(deps, nowMs);
      return { id, status: "failed", headline: FAILED_HEADLINE };
    } catch (error_) {
      if (error_ instanceof SlotTakenError) return null;
      throw error_;
    }
  }
  const text = briefingToastText(composed.brief.counts);
  let id: string;
  try {
    id = deps.store.insertRun({
      firedAt: nowMs,
      firedBy: req.firedBy,
      status: "ok",
      headline: text.body,
      markdown: composed.markdown,
      counts: composed.brief.counts,
      ...slotOf(req),
    });
  } catch (e) {
    if (e instanceof SlotTakenError) return null;
    throw e;
  }
  const outcome = await deliverBriefing(
    deps,
    { runId: id, firedBy: req.firedBy, headline: text.body, counts: { ...composed.brief.counts } },
    text,
    req.toast,
  );
  deps.store.setToastOutcome(id, outcome);
  prune(deps, nowMs);
  return { id, status: "ok", headline: text.body };
}
