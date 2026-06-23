// Shared, pure mapping primitives for the AWS warehouse/ML connector mappers
// (Athena tables, SageMaker models, CloudWatch log groups). These connectors all
// receive AWS-CLI-shaped metadata where timestamps arrive as either ISO-8601
// strings or epoch numbers, and titles/bodies must be length-clamped. Kept in one
// place so the three mappers don't each re-declare an identical copy.

/** Max length for an item title before it is clamped with an ellipsis. */
export const TITLE_MAX = 256;
/** Max length for an item body preview before it is clamped with an ellipsis. */
export const BODY_MAX = 512;

/** Normalise a finite epoch number to millis: a value < 1e12 is treated as seconds. */
export function epochToMs(n: number): number {
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/**
 * Parse an AWS-CLI timestamp to unix MILLIS, else null. Accepts a finite epoch
 * number (seconds or millis, via {@link epochToMs}), a bare numeric string, or an
 * ISO-8601 string. A bare number < 1e12 is treated as seconds; larger as millis.
 */
export function parseTimestampMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return epochToMs(v);
  }
  if (typeof v === "string" && v.trim() !== "") {
    const trimmed = v.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? epochToMs(n) : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Clamp a string to `max` chars, appending an ellipsis when truncated. */
export function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
