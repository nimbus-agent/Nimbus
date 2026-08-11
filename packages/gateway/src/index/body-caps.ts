import { LOCAL_ONLY_PROSE_TYPES, PROSE_HEAVY_TYPES } from "../embedding/routing.ts";

/** Cap for paragraph-shaped item types (`LONG_BODY_TYPES`). */
export const BODY_MAX_PROSE = 16_384;

/** Cap for everything else — unchanged from the pre-V48 behaviour. */
export const BODY_MAX_DEFAULT = 512;

/** `item.body_preview` is always this many code units of `item.body`. */
export const BODY_PREVIEW_MAX = 512;

/**
 * Every type whose body is paragraph-shaped enough to earn `BODY_MAX_PROSE`.
 *
 * This deliberately does NOT read `PROSE_HEAVY_TYPES` alone. That set answers a
 * different question — "may this type's embedding be computed remotely?" — and
 * deriving the storage cap from it coupled a privacy decision to a storage one.
 * Dropping `nimbus:web_clip` from `PROSE_HEAVY_TYPES` to keep clips on-device
 * (#1006) would, under the old derivation, have silently cut the clip body cap
 * from 16,384 back to 512 and re-opened #1005 — a privacy fix regressing a data
 * fix, with no test between them to say so.
 *
 * So the union is explicit: a type gets the long cap if it is prose-heavy for
 * routing OR prose-shaped but pinned to local embedding. A future type added to
 * either set gets the correct cap without a second edit here.
 */
export const LONG_BODY_TYPES: ReadonlySet<string> = new Set([
  ...PROSE_HEAVY_TYPES,
  ...LOCAL_ONLY_PROSE_TYPES,
]);

export function bodyCapForItemType(service: string, type: string): number {
  return LONG_BODY_TYPES.has(`${service}:${type}`) ? BODY_MAX_PROSE : BODY_MAX_DEFAULT;
}

/**
 * Clamp to `max` UTF-16 code units without splitting a surrogate pair.
 *
 * A bare `slice(0, max)` can leave a lone high surrogate, which is not
 * representable in UTF-8 and corrupts the value on its way into SQLite. If the
 * last retained unit is a high surrogate its low partner is being cut, so drop
 * it too.
 */
export function clampBody(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  // `codePointAt`, and the `> 0xFFFF` arm is load-bearing: on the FULL string
  // it returns the COMBINED code point when a low surrogate follows, which is
  // precisely the split being guarded against — so a value above the BMP is
  // itself the answer "the unit at `max - 1` is a high surrogate". The
  // explicit range then covers the other case, a LONE high surrogate with no
  // low partner, which is equally unrepresentable in UTF-8.
  const last = text.codePointAt(max - 1) ?? 0;
  const isHighSurrogate = last > 0xff_ff || (last >= 0xd8_00 && last <= 0xdb_ff);
  return text.slice(0, isHighSurrogate ? max - 1 : max);
}
