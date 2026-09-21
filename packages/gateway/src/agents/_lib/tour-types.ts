// packages/gateway/src/agents/_lib/tour-types.ts

/**
 * The wire shape for `nimbus wow`, a guided tour of the local index across a handful of the
 * existing read-only agents.
 *
 * Lives under `agents/_lib/` — not `agents/<name>.ts` — because static rule D22(d) forbids any
 * file outside `ipc/agents-rpc.ts` from importing an `agents/<name>.ts` emitter (both static and
 * dynamic import forms), and its regex also matches sibling query modules such as
 * `agents/standup-queries.ts` / `agents/oncall-queries.ts`. The tour's per-step selectors need to
 * import those query modules, so the tour code has to live inside the agents package itself;
 * `_lib/` is the precedent-established exception importable from `ipc/` (see `demo-symbol.ts`).
 * This file exports no emitter — only the plan shape every later task consumes.
 */
export const TOUR_STEP_KINDS = [
  "why",
  "owners",
  "oncall",
  "standup",
  "decisions",
  "glossary",
] as const;

export type TourStepKind = (typeof TOUR_STEP_KINDS)[number];

export interface TourStep {
  readonly kind: TourStepKind;
  readonly title: string;
  /** Display only. May carry `--demo`. */
  readonly command: string;
  /** The clean subcommand argv handed to the runner. NEVER contains `--demo`. */
  readonly args: readonly string[];
  readonly reason: string;
}

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

/** `--steps` is refused outside this range, never clamped, in both the CLI parser and the gateway handler. */
export const TOUR_STEPS_MIN = 1;
export const TOUR_STEPS_MAX = 6;
export const TOUR_STEPS_DEFAULT = 3;
