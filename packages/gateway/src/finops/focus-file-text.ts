// Phase 7 (the Cost Pack, slice 11a): the text of one FOCUS export file. A cloud's export arrives gzipped
// (`*.csv.gz`); a hand-copied one may be plain. Pure (static D48): bytes in, text out.
import { FocusCsvError } from "./focus-csv.ts";

/** The most a gzip file may expand to; a bomb is refused, not decoded. */
export const FOCUS_MAX_TEXT_BYTES = 1024 * 1024 * 1024;

/**
 * Gunzips when `name` ends `.gz` or the bytes start `1F 8B`, then decodes strict UTF-8. Throws
 * {@link FocusCsvError} for a corrupt gzip stream, an over-size result or invalid UTF-8.
 */
export function focusFileText(bytes: Uint8Array, name: string): string {
  const gz = name.toLowerCase().endsWith(".gz") || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  let plain: Uint8Array = bytes;
  if (gz) {
    try {
      plain = Bun.gunzipSync(bytes);
    } catch {
      throw new FocusCsvError(`${name.slice(-80)} is not a valid gzip file`);
    }
  }
  if (plain.byteLength > FOCUS_MAX_TEXT_BYTES) {
    throw new FocusCsvError(
      `${name.slice(-80)} is larger than the ${String(FOCUS_MAX_TEXT_BYTES)} byte cap`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    throw new FocusCsvError(`${name.slice(-80)} is not valid UTF-8`);
  }
}
