import { CliExit } from "../lib/cli-exit.ts";
import {
  type LocalityReport,
  PANEL_COMMANDS,
  printLocalityPanel,
  renderLocalityPanel,
} from "../lib/locality-panel.ts";
import {
  defaultTourRunners,
  runTour,
  type TourRunners,
  type TourStep,
  type TourStepKind,
} from "../lib/run-tour.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import type { ProveResult } from "./prove.ts";

export { PANEL_COMMANDS, renderLocalityPanel };

/**
 * Structural mirror of the gateway's `agents/_lib/tour-types.ts` `TourPlan` / `TourSkip` — the CLI
 * cannot import gateway source (dependency rule). `TourStep` already has a CLI-side mirror in
 * `run-tour.ts` (B8); this file adds the two wrapper shapes that task did not need.
 */
export interface TourSkip {
  readonly kind: TourStepKind;
  readonly reason: string;
}

export interface TourPlan {
  readonly steps: readonly TourStep[];
  readonly more: readonly TourStep[];
  readonly skipped: readonly TourSkip[];
  readonly t0: number;
}

/**
 * Mirrors the gateway's `TOUR_STEPS_MIN`/`MAX`/`DEFAULT` (`agents/_lib/tour-types.ts`) — the CLI
 * cannot import them, and both sides must refuse (never clamp) `--steps` outside this range.
 */
const WOW_STEPS_MIN = 1;
const WOW_STEPS_MAX = 6;
const WOW_STEPS_DEFAULT = 3;

const WOW_USAGE = "Usage: nimbus wow [--steps 1..6] [--no-proof] [--json]";

export interface WowDeps {
  readonly plan: (steps: number) => Promise<TourPlan>;
  readonly locality: () => Promise<LocalityReport>;
  readonly prove: (since: number, until: number) => Promise<ProveResult>;
  readonly runners: TourRunners;
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

export const defaultWowDeps: WowDeps = {
  plan: (steps) => withGatewayIpc((c) => c.call<TourPlan>("tour.plan", { steps })),
  locality: () => withGatewayIpc((c) => c.call<LocalityReport>("locality.report", {})),
  prove: (since, until) =>
    withGatewayIpc((c) => c.call<ProveResult>("egress.proveWindow", { since, until })),
  runners: defaultTourRunners,
  out: (s) => {
    process.stdout.write(s);
  },
  err: (s) => {
    process.stderr.write(s);
  },
};

export interface WowArgs {
  readonly steps: number;
  readonly json: boolean;
  readonly noProof: boolean;
}

/**
 * `--steps` is refused (never clamped) outside `1..6` — the same rule the gateway's own
 * `tour.plan` handler enforces, so a client-side bypass here would only be caught a round-trip
 * later. An unrecognised flag is refused too, not silently ignored: a typo on a command whose
 * whole point is trustworthy output should not become a silent no-op.
 */
export function parseWowArgs(args: readonly string[]): WowArgs {
  let steps = WOW_STEPS_DEFAULT;
  let json = false;
  let noProof = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--steps") {
      const raw = args[++i];
      if (raw === undefined) {
        throw new Error(`--steps requires a value in ${WOW_STEPS_MIN}..${WOW_STEPS_MAX}`);
      }
      if (!/^\d+$/.test(raw)) {
        throw new Error(
          `--steps must be an integer in ${WOW_STEPS_MIN}..${WOW_STEPS_MAX}, got ${raw}`,
        );
      }
      const n = Number.parseInt(raw, 10);
      if (n < WOW_STEPS_MIN || n > WOW_STEPS_MAX) {
        throw new Error(
          `--steps must be an integer in ${WOW_STEPS_MIN}..${WOW_STEPS_MAX}, got ${raw}`,
        );
      }
      steps = n;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--no-proof") {
      noProof = true;
      continue;
    }
    throw new Error(`Unknown argument to nimbus wow: ${a}`);
  }
  return { steps, json, noProof };
}

/**
 * `nimbus wow` — a deterministic guided tour of the local index (1..6 steps, `tour.plan`), run
 * through the same command runners a user would type themselves, closing on the locality panel:
 * which listeners are open right now, what the index holds, and a proof line about outbound
 * activity during the tour window.
 *
 * The proof window is EXACTLY `{since: plan.t0, until: locality.t1}` — both edges are GATEWAY
 * clock values read from the two prior calls, never `Date.now()` computed here, so the window
 * matches what the gateway itself can account for. `locality()` is called only AFTER every tour
 * step has run, and `prove()` only after `locality()` resolves — that order is load-bearing (an
 * `until` computed before the tour finished would understate what the tour itself did) and is
 * pinned by a call-order test in `wow.test.ts`, not just by fixed-fixture assertions that a
 * hoisted call would still satisfy.
 */
export async function runWow(args: string[], deps: WowDeps = defaultWowDeps): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    deps.out(`${WOW_USAGE}\n`);
    return;
  }

  let parsed: WowArgs;
  try {
    parsed = parseWowArgs(args);
  } catch (e) {
    deps.err(`${e instanceof Error ? e.message : String(e)}\n${WOW_USAGE}\n`);
    throw new CliExit(2);
  }

  const plan = await deps.plan(parsed.steps);

  if (parsed.json) {
    const locality = await deps.locality();
    deps.out(`${JSON.stringify({ plan, locality }, null, 2)}\n`);
    return;
  }

  if (plan.steps.length === 0) {
    deps.out("Nothing indexed yet — run `nimbus init` in a repo.\n");
    return;
  }

  // The panel counts as one more step of the total unless `--no-proof` drops it, so the tour's own
  // step headers read "[1/N+1]" rather than under-counting what actually prints.
  const total = plan.steps.length + (parsed.noProof ? 0 : 1);
  const results = await runTour(plan.steps, deps.runners, deps.out, deps.err, total);

  // The locality/prove/panel sequence lives in `printLocalityPanel` — `nimbus demo` closes on the
  // same one, and a second copy here is a second place for the window edges to drift.
  let proveFailed = false;
  if (!parsed.noProof) {
    ({ proveFailed } = await printLocalityPanel(
      { locality: deps.locality, prove: deps.prove, out: deps.out },
      plan.t0,
      total,
    ));
  }

  for (const skip of plan.skipped) {
    deps.out(`Not shown: ${skip.kind} (${skip.reason})\n`);
  }
  if (plan.more.length > 0) {
    deps.out("Also try:\n");
    for (const m of plan.more) {
      deps.out(`  ${m.command}\n`);
    }
  }

  // Printed AFTER the panel and the skip/more lists — the brief's ordering — so a failed step (or
  // a failed prove call) never hides the honesty panel or the plan's own disclosures behind it.
  if (results.some((r) => !r.ok) || proveFailed) {
    throw new CliExit(1);
  }
}
