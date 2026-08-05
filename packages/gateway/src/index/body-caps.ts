import { PROSE_HEAVY_TYPES } from "../embedding/routing.ts";

/** Cap for paragraph-shaped item types (`PROSE_HEAVY_TYPES`). */
export const BODY_MAX_PROSE = 16_384;

/** Cap for everything else — unchanged from the pre-V48 behaviour. */
export const BODY_MAX_DEFAULT = 512;

/** `item.body_preview` is always this many code units of `item.body`. */
export const BODY_PREVIEW_MAX = 512;

export function bodyCapForItemType(service: string, type: string): number {
  return PROSE_HEAVY_TYPES.has(`${service}:${type}`) ? BODY_MAX_PROSE : BODY_MAX_DEFAULT;
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
