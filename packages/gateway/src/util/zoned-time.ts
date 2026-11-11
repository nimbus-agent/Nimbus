/**
 * A wall time in an IANA zone to an instant (Phase 10 MB1). The zone is always a PARAMETER, never read
 * inside the pure function, so a test is deterministic on every CI OS.
 *
 * It does not reuse `automation/cron.ts`'s private `instantOf` (minute resolution; `undefined` in a DST
 * gap). Here a NONEXISTENT local time (inside a spring-forward gap) resolves with the offset in force
 * BEFORE the gap (RFC 5545 section 3.3.5), and a repeated one (a fall-back hour) resolves to its FIRST
 * occurrence.
 */
export interface WallTime {
  readonly y: number;
  readonly mo: number;
  readonly d: number;
  readonly h: number;
  readonly mi: number;
  readonly s: number;
}

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;
  let f: Intl.DateTimeFormat | null;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    f = null;
  }
  formatters.set(zone, f);
  return f;
}

/** The zone's UTC offset in ms at instant `t` (wall time minus instant). */
function offsetAt(f: Intl.DateTimeFormat, t: number): number {
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(t))) {
    if (p.type !== "literal") parts[p.type] = Number.parseInt(p.value, 10);
  }
  // `formatToParts` with these options always yields every part; a missing one would be NaN here and
  // make the whole result non-finite, which `wallToInstantMs` refuses. No silent default.
  const wall = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]),
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  const wholeSecond = t - (((t % 1000) + 1000) % 1000);
  return wall - wholeSecond;
}

/** Epoch ms of `wall` in `zone`, or `undefined` for an unknown zone. */
export function wallToInstantMs(wall: WallTime, zone: string): number | undefined {
  const f = formatterFor(zone);
  if (f === null) return undefined;
  const asUtc = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);
  if (!Number.isFinite(asUtc)) return undefined;
  const before = offsetAt(f, asUtc - DAY_MS);
  const after = offsetAt(f, asUtc + DAY_MS);
  const candidates = [asUtc - before, asUtc - after].filter((c, i, all) => all.indexOf(c) === i);
  const valid = candidates.filter((c) => offsetAt(f, c) === asUtc - c);
  if (valid.length > 0) return Math.min(...valid);
  // Inside a gap: the offset in force before it.
  return asUtc - before;
}

/** The gateway's own zone name (an IANA id), for floating times and all-day dates. */
export function gatewayZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The wall clock of instant `ms` in `zone`, or `undefined` for an unknown zone or a non-finite instant. */
export function wallOfInstant(ms: number, zone: string): WallTime | undefined {
  const f = formatterFor(zone);
  if (f === null || !Number.isFinite(ms)) return undefined;
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number.parseInt(p.value, 10);
  }
  return {
    y: Number(parts["year"]),
    mo: Number(parts["month"]),
    d: Number(parts["day"]),
    h: Number(parts["hour"]),
    mi: Number(parts["minute"]),
    s: Number(parts["second"]),
  };
}
