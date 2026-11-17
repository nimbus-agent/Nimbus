import { stripControlChars } from "./strip-control-chars.ts";

/**
 * Third-party text bound for a terminal: C0/C1 controls and DEL are dropped (`stripControlChars`), and so are
 * the Unicode direction controls (LRM/RLM U+200E-U+200F, the embedding and override block U+202A-U+202E, and the
 * isolate block U+2066-U+2069), which can make a title read in a different order from how it is stored. Indexed
 * titles, chat text and provider names are third-party text. The class is written with escapes so the source
 * itself carries no direction control.
 */
const DIRECTION_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

export function stripTerminalText(s: string): string {
  return stripControlChars(s).replace(DIRECTION_CONTROLS, "");
}
