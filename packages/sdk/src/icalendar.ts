/**
 * Pure, dependency-free iCalendar (RFC 5545) build/parse module.
 *
 * Lives in @nimbus-dev/sdk so both the apple connector and the gateway can
 * share one implementation without duplication (the gateway depends on the SDK
 * via workspace:*, and connectors depend on the SDK by rule).
 *
 * Design constraints:
 * - No I/O (pure functions)
 * - No dependencies
 * - No Date.now() — callers inject `now` for testability
 * - No `any` — uses `unknown` for external data
 * - Never throws on malformed input (best-effort / skip)
 */

// ---------------------------------------------------------------------------
// ParsedEvent
// ---------------------------------------------------------------------------

export interface ParsedEvent {
  readonly uid: string;
  readonly recurrenceId: string | null;
  readonly summary: string | null;
  readonly description: string | null;
  readonly location: string | null;
  readonly start: string | null;
  readonly end: string | null;
  readonly allDay: boolean;
  readonly status: string | null;
  readonly organizer: string | null;
  readonly attendees: readonly string[];
  readonly rrule: string | null;
  readonly dtstamp: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * RFC 5545 §3.1 line unfolding:
 * A CRLF immediately followed by a SPACE or HTAB is removed (the following
 * character is a continuation of the previous logical line).
 */
function unfoldLines(ics: string): string {
  // Normalize bare \n to \r\n first so we handle both endings robustly.
  const normalized = ics.replace(/\r?\n/g, "\r\n");
  return normalized.replace(/\r\n[ \t]/g, "");
}

/**
 * Unescape iCalendar text values (RFC 5545 §3.3.11):
 *   \\  → \
 *   \,  → ,
 *   \;  → ;
 *   \n / \N → newline
 */
function unescapeValue(value: string): string {
  // Single left-to-right pass. Sequential global replaces cannot decode
  // correctly at any ordering: e.g. the wire value `\\n` (escaped backslash
  // then a literal `n`) must yield the two chars `\n`, but a `\\\\`→`\` pass
  // followed by a `\\n`→newline pass would collapse it to a newline. Scanning
  // char-by-char and consuming the escaped char fixes this.
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      i++; // consume the escaped character
      if (next === "n" || next === "N") {
        out += "\n";
      } else {
        // \\ → \, \, → ,, \; → ;, and any other escape → the literal char
        out += next;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Extract the value part from a logical content line.
 * A content line has the form: NAME[;PARAMS]:VALUE
 * We strip everything up to and including the first unescaped `:`.
 */
function extractValue(line: string): string {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return "";
  return line.slice(colonIdx + 1);
}

/**
 * Extract the property name (the part before `;` or `:`).
 */
function extractName(line: string): string {
  const semicolonIdx = line.indexOf(";");
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return line.toUpperCase();
  const nameEnd = semicolonIdx !== -1 && semicolonIdx < colonIdx ? semicolonIdx : colonIdx;
  return line.slice(0, nameEnd).toUpperCase();
}

/**
 * Check whether a content line carries an exact `NAME=VALUE` parameter token
 * (e.g. `VALUE=DATE`). Inspects the param portion (between the property name's
 * first `;` and the value-starting `:`) and matches a whole `;`-delimited token
 * so `VALUE=DATE` does NOT spuriously match `VALUE=DATE-TIME`.
 */
function hasParam(line: string, param: string): boolean {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return false;
  const nameEnd = line.indexOf(";");
  // No params (`;` absent or after the value separator) → nothing to match.
  if (nameEnd === -1 || nameEnd > colonIdx) return false;
  const paramSection = line.slice(nameEnd + 1, colonIdx).toUpperCase();
  const target = param.toUpperCase();
  return paramSection.split(";").some((tok) => tok === target);
}

/**
 * Extract a `mailto:` address from a property value (ATTENDEE/ORGANIZER lines).
 * Returns the address (without `mailto:` prefix) or null.
 */
function extractMailto(value: string): string | null {
  // The mailto: may appear after parameters in the VALUE part
  const lower = value.toLowerCase();
  const idx = lower.indexOf("mailto:");
  if (idx === -1) return null;
  return value.slice(idx + "mailto:".length).trim();
}

/**
 * Split the unfolded ICS text into raw VEVENT blocks.
 * Each block is the text between BEGIN:VEVENT and END:VEVENT (exclusive).
 */
function splitVEvents(unfolded: string): string[] {
  const blocks: string[] = [];
  const lines = unfolded.split("\r\n");
  let inEvent = false;
  let current: string[] = [];

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      inEvent = true;
      current = [];
      continue;
    }
    if (upper === "END:VEVENT") {
      if (inEvent) {
        blocks.push(current.join("\r\n"));
      }
      inEvent = false;
      current = [];
      continue;
    }
    if (inEvent) {
      current.push(line);
    }
  }

  return blocks;
}

/**
 * Parse one unfolded VEVENT block's lines into a ParsedEvent.
 * Returns null when UID is absent or empty (caller skips the block).
 */
function parseVEventBlock(block: string): ParsedEvent | null {
  const lines = block.split("\r\n").filter((l) => l.length > 0);

  let uid: string | null = null;
  let recurrenceId: string | null = null;
  let summary: string | null = null;
  let description: string | null = null;
  let location: string | null = null;
  let start: string | null = null;
  let end: string | null = null;
  let allDay = false;
  let status: string | null = null;
  let organizer: string | null = null;
  const attendees: string[] = [];
  let rrule: string | null = null;
  let dtstamp: string | null = null;

  for (const line of lines) {
    // Skip blank lines that may appear due to unfolding artifacts
    if (!line.trim()) continue;

    const name = extractName(line);
    const rawValue = extractValue(line);

    switch (name) {
      case "UID":
        uid = rawValue.trim();
        break;
      case "RECURRENCE-ID":
        recurrenceId = rawValue.trim();
        break;
      case "SUMMARY":
        summary = unescapeValue(rawValue);
        break;
      case "DESCRIPTION":
        description = unescapeValue(rawValue);
        break;
      case "LOCATION":
        location = unescapeValue(rawValue);
        break;
      case "DTSTART": {
        const isDate = hasParam(line, "VALUE=DATE");
        start = rawValue.trim();
        allDay = isDate;
        break;
      }
      case "DTEND":
        end = rawValue.trim();
        break;
      case "STATUS":
        status = rawValue.trim();
        break;
      case "ORGANIZER": {
        const addr = extractMailto(rawValue);
        organizer = addr;
        break;
      }
      case "ATTENDEE": {
        const addr = extractMailto(rawValue);
        if (addr !== null && addr.length > 0) {
          attendees.push(addr);
        }
        break;
      }
      case "RRULE":
        rrule = rawValue.trim();
        break;
      case "DTSTAMP":
        dtstamp = rawValue.trim();
        break;
      default:
        // Unknown properties are ignored
        break;
    }
  }

  // Skip blocks with no UID or an empty UID
  if (uid === null || uid === "") return null;

  return {
    uid,
    recurrenceId,
    summary,
    description,
    location,
    start,
    end,
    allDay,
    status,
    organizer,
    attendees,
    rrule,
    dtstamp,
  };
}

// ---------------------------------------------------------------------------
// parseICalendar
// ---------------------------------------------------------------------------

/**
 * Parse an iCalendar (ICS) string and return one ParsedEvent per VEVENT block.
 *
 * - Lines are unfolded per RFC 5545 §3.1 before parsing.
 * - Multiple VEVENTs (master + RECURRENCE-ID overrides, or server-expanded
 *   occurrences) each produce one ParsedEvent.
 * - Blocks with no UID are silently skipped.
 * - Never throws; malformed input is handled best-effort.
 */
export function parseICalendar(ics: string): ParsedEvent[] {
  try {
    const unfolded = unfoldLines(ics);
    const blocks = splitVEvents(unfolded);
    const results: ParsedEvent[] = [];

    for (const block of blocks) {
      try {
        const event = parseVEventBlock(block);
        if (event !== null) {
          results.push(event);
        }
      } catch {
        // Skip malformed blocks
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// BuildEventInput + buildVEvent
// ---------------------------------------------------------------------------

export interface BuildEventInput {
  readonly uid: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly description?: string;
  readonly location?: string;
  readonly attendees?: readonly string[];
}

/**
 * Escape a text value for use in an iCalendar TEXT property (RFC 5545 §3.3.11).
 * Order matters: backslash must be escaped first.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

const CRLF = "\r\n";

/**
 * Build a complete VCALENDAR/VEVENT iCalendar string from the given input.
 *
 * @param input - The event properties to encode.
 * @param now   - The current timestamp in iCalendar DTSTAMP format
 *                (e.g. "20260601T090000Z"). Injected by the caller; this
 *                function never calls Date.now().
 * @returns A valid ICS string with CRLF line endings.
 */
export function buildVEvent(input: BuildEventInput, now: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${input.start}`,
    `DTEND:${input.end}`,
    `SUMMARY:${escapeText(input.summary)}`,
  ];

  if (input.description !== undefined) {
    lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  }
  if (input.location !== undefined) {
    lines.push(`LOCATION:${escapeText(input.location)}`);
  }
  if (input.attendees !== undefined) {
    for (const addr of input.attendees) {
      lines.push(`ATTENDEE:mailto:${addr}`);
    }
  }

  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.join(CRLF) + CRLF;
}
