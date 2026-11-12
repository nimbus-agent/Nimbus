import { gatewayZone, type WallTime, wallOfInstant, wallToInstantMs } from "./zoned-time.ts";

/**
 * The `--at <time>` parser for `nimbus ask`, `nimbus query` and `nimbus search` (Phase 10 IC1,
 * incident-engine spec § 5.1). It lives in the GATEWAY so the zone is the gateway's ({@link gatewayZone});
 * the CLI sends the raw string. `nowMs` and `zone` are PARAMETERS, so the file behaves identically on all
 * three OSes under test.
 *
 * Forms: an ISO instant with an offset (`2026-11-11T09:00:00Z`, `2026-11-11T09:00+02:00`), an ISO local
 * time or date in the zone (`2026-11-11T09:00`, `2026-11-11 09:00`, `2026-11-11`), `yesterday-HH:MM` and
 * `today-HH:MM` in the zone, and a relative offset into the past (`-2h`, `-30m`, `-1d`, `-90s`, `-1w`; `-0h`
 * is now). The parser owns its unit table: `parseRelativeSinceToWindowMs` has other callers that pin it.
 *
 * A nonexistent local time (inside a spring-forward gap) resolves with the offset before the gap, via
 * `wallToInstantMs`. An instant in the future of `nowMs`, or before 2000-01-01, is refused.
 */

export class AtTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtTimeError";
  }
}

const ACCEPTED =
  "Accepted forms: 2026-11-11T09:00Z, 2026-11-11T09:00 (gateway time zone), 2026-11-11, yesterday-09:00, today-14:30, -2h (units s, m, h, d, w).";
const EARLIEST_MS = Date.UTC(2000, 0, 1);
type Unit = "s" | "m" | "h" | "d" | "w";
const UNIT_MS: Readonly<Record<Unit, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const RELATIVE_RE = /^-(\d{1,9})\s*([smhdw])$/i;
const KEYWORD_RE = /^(today|yesterday)-(\d{2}):(\d{2})$/i;
const OFFSET_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?(Z|z|[+-]\d{2}:\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

function fail(detail: string): never {
  throw new AtTimeError(`${detail} ${ACCEPTED}`);
}

function wallOf(y: number, mo: number, d: number, h: number, mi: number, s: number): WallTime {
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const real =
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === mo - 1 &&
    probe.getUTCDate() === d &&
    h <= 23 &&
    mi <= 59 &&
    s <= 59;
  if (!real) fail("That date or time does not exist.");
  return { y, mo, d, h, mi, s };
}

function num(s: string | undefined): number {
  return Number(s ?? "0");
}

function inZone(wall: WallTime, zone: string): number {
  const ms = wallToInstantMs(wall, zone);
  if (ms === undefined) fail(`Unknown time zone "${zone}".`);
  return ms;
}

function parseRelative(raw: string, nowMs: number): number | undefined {
  const m = RELATIVE_RE.exec(raw);
  if (m === null) return undefined;
  return nowMs - num(m[1]) * UNIT_MS[(m[2] as string).toLowerCase() as Unit];
}

function parseKeyword(raw: string, nowMs: number, zone: string): number | undefined {
  const m = KEYWORD_RE.exec(raw);
  if (m === null) return undefined;
  const today = wallOfInstant(nowMs, zone);
  if (today === undefined) fail(`Unknown time zone "${zone}".`);
  const back = (m[1] as string).toLowerCase() === "yesterday" ? 1 : 0;
  const day = new Date(Date.UTC(today.y, today.mo - 1, today.d - back));
  const wall = wallOf(
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    num(m[2]),
    num(m[3]),
    0,
  );
  return inZone(wall, zone);
}

function parseWithOffset(raw: string): number | undefined {
  const m = OFFSET_RE.exec(raw);
  if (m === null) return undefined;
  const wall = wallOf(num(m[1]), num(m[2]), num(m[3]), num(m[4]), num(m[5]), num(m[6]));
  const utc = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);
  const off = m[7] as string;
  if (off.toUpperCase() === "Z") return utc;
  const sign = off.startsWith("-") ? -1 : 1;
  const hh = num(off.slice(1, 3));
  const mm = num(off.slice(4, 6));
  if (hh > 23 || mm > 59) fail("That UTC offset does not exist.");
  return utc - sign * (hh * 60 + mm) * 60_000;
}

function parseLocal(raw: string, zone: string): number | undefined {
  const m = LOCAL_RE.exec(raw);
  if (m === null) return undefined;
  const wall = wallOf(num(m[1]), num(m[2]), num(m[3]), num(m[4]), num(m[5]), num(m[6]));
  return inZone(wall, zone);
}

/** `raw` as an instant (epoch ms). Throws {@link AtTimeError} with a fixed, form-naming message. */
export function parseAtTime(raw: string, nowMs: number, zone: string = gatewayZone()): number {
  const text = raw.trim();
  if (text === "") fail("--at needs a time.");
  const ms =
    parseRelative(text, nowMs) ??
    parseKeyword(text, nowMs, zone) ??
    parseWithOffset(text) ??
    parseLocal(text, zone);
  if (ms === undefined) fail(`"${text}" is not a time I can read.`);
  if (ms > nowMs) fail("That time is in the future; --at answers as the index stood.");
  if (ms < EARLIEST_MS) fail("That time is before 2000-01-01.");
  return ms;
}
