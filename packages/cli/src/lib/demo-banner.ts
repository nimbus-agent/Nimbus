import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Mirrors the gateway's `DEMO_SEED_MARKER` (demo/seed.ts); scripts/parity keeps them equal. */
export const DEMO_SEED_MARKER = "demo-seed.json";
/** The narrowest agent window (standup/oncall) — past it the seeded data falls out of the briefs. */
export const DEMO_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function readDemoSeedMarker(dataDir: string): { readonly seededAtMs: number } | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, DEMO_SEED_MARKER), "utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const v = (raw as Record<string, unknown>)["seededAtMs"];
    return typeof v === "number" && Number.isFinite(v) ? { seededAtMs: v } : undefined;
  } catch {
    return undefined;
  }
}

function age(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${String(h)}h ago`;
  return `${String(Math.floor(h / 24))}d ago`;
}

/** The one stderr line every `--demo` command prints (spec § 5). */
export function demoBannerLine(
  marker: { readonly seededAtMs: number } | undefined,
  nowMs: number,
): string {
  if (marker === undefined) return "DEMO — not seeded yet · run nimbus demo";
  const elapsed = nowMs - marker.seededAtMs;
  if (elapsed > DEMO_STALE_AFTER_MS) {
    return `DEMO — synthetic "Acme" org · seeded ${age(elapsed)} (stale — briefs may be empty) · run nimbus demo to re-seed`;
  }
  return `DEMO — synthetic "Acme" org, not your data · seeded ${age(elapsed)} · nimbus demo reset to remove`;
}
