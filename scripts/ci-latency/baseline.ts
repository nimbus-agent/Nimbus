/**
 * The committed baseline: one `execMedian` + `execSpread` per key.
 *
 * The spread is stored, not recomputed at check time, because the gate compares
 * today's median against the noise band the baseline was TAKEN with. Recomputing
 * it from the current window would let a job that is becoming erratic widen its
 * own tolerance, which is exactly backwards.
 */

import { MIN_SAMPLES, MIN_SAMPLES_FOR_RATCHET } from "./constants.ts";
import type { BaselineEntry, KeySummary, LatencyBaseline } from "./types.ts";

interface RawBaseline {
  version?: unknown;
  generated_at?: unknown;
  entries?: unknown;
}

export function parseBaseline(json: string): LatencyBaseline {
  let raw: RawBaseline;
  try {
    raw = JSON.parse(json) as RawBaseline;
  } catch {
    throw new Error("ci-latency baseline: file is not valid JSON");
  }
  const entries = new Map<string, BaselineEntry>();
  const rawEntries = raw.entries;
  if (typeof rawEntries === "object" && rawEntries !== null) {
    for (const [k, v] of Object.entries(rawEntries as Record<string, unknown>)) {
      if (typeof v !== "object" || v === null) continue;
      const e = v as { execMedian?: unknown; execSpread?: unknown };
      if (typeof e.execMedian !== "number" || typeof e.execSpread !== "number") continue;
      entries.set(k, { execMedian: e.execMedian, execSpread: e.execSpread });
    }
  }
  return {
    version: 1,
    generated_at: typeof raw.generated_at === "string" ? raw.generated_at : "",
    entries,
  };
}

export function serializeBaseline(b: LatencyBaseline): string {
  // Sorted so a regenerated baseline produces a minimal, reviewable diff.
  const obj: Record<string, BaselineEntry> = {};
  for (const k of [...b.entries.keys()].sort()) {
    const e = b.entries.get(k);
    if (e) obj[k] = { execMedian: round2(e.execMedian), execSpread: round2(e.execSpread) };
  }
  return `${JSON.stringify({ version: 1, generated_at: b.generated_at, entries: obj }, null, 2)}\n`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The ratchet. Raising is unconditional (an explicit `--update-baseline` accepts
 * the new reality); LOWERING requires `MIN_SAMPLES_FOR_RATCHET` observations,
 * because a wrongly-low bound produces a permanently red gate and three
 * consecutive hot-cache runs is a plausible window.
 *
 * A key OBSERVED but too sparse to trust (`samples < MIN_SAMPLES`) retains its
 * existing baseline entry rather than being deleted — a quiet-fortnight
 * regeneration of a rarely-run workflow (e.g. `Release`) must not make that key
 * vanish and come back as an ungated `new-key`, which is a false green in the
 * ratchet's own favour. A sparse key with no prior entry has nothing to
 * preserve and is still omitted.
 *
 * A key ABSENT from the current window entirely is dropped: it was renamed or
 * deleted, and keeping it would strand a baseline entry nothing can ever
 * satisfy.
 */
export function computeUpdatedBaseline(
  current: LatencyBaseline,
  summaries: ReadonlyMap<string, KeySummary>,
  now: string,
): LatencyBaseline {
  const entries = new Map<string, BaselineEntry>();
  for (const [key, s] of summaries) {
    const prev = current.entries.get(key);
    if (s.samples < MIN_SAMPLES) {
      if (prev) entries.set(key, prev);
      continue;
    }
    if (prev && s.execMedian < prev.execMedian && s.samples < MIN_SAMPLES_FOR_RATCHET) {
      entries.set(key, prev);
      continue;
    }
    entries.set(key, { execMedian: s.execMedian, execSpread: s.execSpread });
  }
  return { version: 1, generated_at: now, entries };
}
