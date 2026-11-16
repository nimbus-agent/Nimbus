// Shared low-level TOML line/value primitives used by both the per-section
// config parsers in `nimbus-toml.ts` and the DORA/CI service-config parsers in
// `service-config-toml.ts`. Keeping them in a dependency-free module avoids a
// circular import between those two files.

type LineScan = { text: string; unterminated: boolean };

/**
 * One left-to-right pass. `escapes` decides whether a backslash inside a
 * string consumes the next character.
 *
 * Both modes exist because neither alone is correct for every value this
 * parser has always accepted. With escapes on, `"he said \"hi\""` scans
 * correctly but `"C:\dev\"` looks unterminated. With escapes off, the reverse.
 * `scanLine` is called twice (see `stripComment`) so both survive.
 */
function scanLine(line: string, escapes: boolean): LineScan {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escapes && inString && ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (ch === "#" && !inString) {
      return { text: line.slice(0, i), unterminated: false };
    }
  }
  return { text: line, unterminated: inString };
}

/**
 * Strips a trailing `#` comment, ignoring `#` inside a double-quoted value.
 *
 * The escape-aware pass runs first; if it ends inside a string the line is
 * re-scanned with backslash as a literal, which is what rescues a Windows
 * path written as `"C:\dev\"`. A line malformed under BOTH passes is returned
 * with its comment left intact — callers detect it via `hasUnterminatedString`
 * and skip the entry rather than acting on a truncated value.
 */
export function stripComment(line: string): string {
  const withEscapes = scanLine(line, true);
  if (!withEscapes.unterminated) return withEscapes.text;
  const literal = scanLine(line, false);
  return literal.unterminated ? line : literal.text;
}

/** True when the line's double-quoted string never closes under either scan. */
export function hasUnterminatedString(line: string): boolean {
  return scanLine(line, true).unterminated && scanLine(line, false).unterminated;
}

/**
 * Unquotes a double-quoted value and unescapes `\"` — and DELIBERATELY nothing
 * else.
 *
 * This is not an incomplete TOML decoder waiting to be finished. The same
 * function parses path-valued keys (`piper_path`, `llamacpp_server_path`,
 * `whisper_path`, `classifier_model`, …), so teaching it `\n` / `\t` / `\\`
 * would read `C:\tools\new\table.onnx` as `C:` TAB `ools` NEWLINE `ew` TAB
 * `able.onnx` and break every Windows install pointing at a local binary.
 * `\"` is safe because no plausible path contains it. See spec §3.3.
 */
export function parseString(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replaceAll(String.raw`\"`, '"');
  }
  return t;
}

/** TOML booleans. `undefined` for anything else, so a malformed value leaves the default alone. */
export function parseBool(raw: string): boolean | undefined {
  const s = raw.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return undefined;
}

/**
 * A whole decimal integer, or `undefined`.
 *
 * `Number.parseInt` alone reads a PREFIX: it turns `1day` into `1`, `3abc` into `3` and `0x10` into
 * `0`, so a config carrying a unit suffix TOML does not have would be silently half-read rather than
 * rejected. That produced an inconsistency once `[fleet] retention_days` started refusing values
 * below 1 — `retention_days = 0days` threw a config error while `retention_days = 1day` was
 * accepted as 1 — and the general case is worse than the inconsistency: a value the writer clearly
 * meant as something else is taken as a number nobody chose.
 *
 * The token must therefore be complete. A malformed value returns `undefined`, which every caller
 * already treats as "leave the default alone", so this narrows what is ACCEPTED and changes nothing
 * about how a rejection is handled.
 */
const DECIMAL_INT_RE = /^[+-]?\d+$/;

export function parseIntDec(raw: string): number | undefined {
  const t = raw.trim();
  if (!DECIMAL_INT_RE.test(t)) return undefined;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function isTableHeader(trimmed: string): boolean {
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

export function splitKeyValue(trimmed: string): { key: string; valRaw: string } | undefined {
  const eq = trimmed.indexOf("=");
  if (eq <= 0) {
    return undefined;
  }
  return { key: trimmed.slice(0, eq).trim(), valRaw: trimmed.slice(eq + 1).trim() };
}

/** Split on commas that are not inside a double-quoted string (a backslash escapes the next character there). */
function splitOutsideQuotes(inner: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quoted && ch === "\\") i += 1;
    else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

export function parseStringArray(raw: string): string[] {
  const t = raw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) {
    throw new TypeError(`expected array, got: ${raw}`);
  }
  const inner = t.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const out: string[] = [];
  for (const part of splitOutsideQuotes(inner)) {
    const v = parseString(part);
    if (v.length > 0) out.push(v);
  }
  return out;
}
