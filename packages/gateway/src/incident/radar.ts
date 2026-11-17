import type { Expectation } from "../config/incident-predict-toml.ts";

/**
 * The expectation radar (Phase 10 IC8, incident-engine spec § 5.8): pure. Given each expectation's last matching
 * event, decide which are overdue (a radar finding opens or stays open) and which are satisfied (an open one
 * clears). An `unknown` last event (the index could not answer, e.g. a capped scan) changes nothing, so a gap in
 * the data never opens or clears a finding. Detection never acts (D-IC-5).
 */

export type LastEvent =
  | { readonly known: true; readonly atMs: number | null }
  | { readonly known: false };

export type RadarVerdict = {
  readonly expectation: Expectation;
  readonly state: "overdue" | "ok" | "unknown";
  readonly lastAtMs: number | null;
};

export function evaluateRadar(
  expectations: readonly Expectation[],
  lastEventOf: (e: Expectation) => LastEvent,
  nowMs: number,
): RadarVerdict[] {
  return expectations.map((expectation) => {
    const last = lastEventOf(expectation);
    if (!last.known) return { expectation, state: "unknown", lastAtMs: null };
    const overdue = last.atMs === null || nowMs - last.atMs > expectation.maxGapMs;
    return { expectation, state: overdue ? "overdue" : "ok", lastAtMs: last.atMs };
  });
}
