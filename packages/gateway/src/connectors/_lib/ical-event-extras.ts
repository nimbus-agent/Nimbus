/**
 * What `@nimbus-dev/sdk` `parseICalendar` drops (Phase 10 MB1), re-read from the SAME raw ICS: the
 * SDK `extractValue` keeps only the text after the first colon, so every property parameter is gone
 * (TZID, PARTSTAT) and `DURATION` is not parsed. The SDK battery is frozen and lives in another repo,
 * so this is a gateway-local companion, never a replacement: it returns, per VEVENT keyed `<uid>` or
 * `<uid>:<recurrence-id>` (the key `apple-event-mapping.ts` already uses), only what the SDK lacks.
 *
 * Malformed lines are skipped, never thrown (the SDK parser contract). Components nested in a
 * VEVENT (a VALARM has its own DURATION and TRIGGER) are skipped.
 */
export interface IcalEventExtras {
  readonly startTzid: string | undefined;
  readonly endTzid: string | undefined;
  readonly durationMs: number | undefined;
  /**
   * The same DURATION split the way RFC 5545 section 3.3.6 defines it: `days` (weeks x 7 + days) are
   * NOMINAL (a calendar day in the event's zone, 23 or 25 hours across a DST change) and `ms` is the
   * EXACT hour/minute/second part. `durationMs` flattens both to 24-hour days.
   */
  readonly durationParts: IcalDurationParts | undefined;
  /** Lower-cased attendee address -> a KNOWN PARTSTAT, lower-cased. An unknown value is ignored. */
  readonly partstatByAddress: ReadonlyMap<string, string>;
}

const KNOWN_PARTSTATS = new Set(["accepted", "declined", "tentative", "needs-action"]);

type ContentLine = {
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
};

/** The index of the first `;` or `:` at or after `from`, or the line length when there is none. */
function delimiterAt(line: string, from: number): number {
  let i = from;
  while (i < line.length && line[i] !== ";" && line[i] !== ":") i += 1;
  return i;
}

/** One parameter value starting at `i` (quoted or bare) and the index just past it, or `undefined`. */
function readParamValue(line: string, i: number): { val: string; next: number } | undefined {
  if (line[i] !== '"') {
    const end = delimiterAt(line, i);
    return { val: line.slice(i, end), next: end };
  }
  const close = line.indexOf('"', i + 1);
  if (close < 0) return undefined;
  return { val: line.slice(i + 1, close), next: close + 1 };
}

/** Splits `NAME;P=V;Q="a:b":value`, honoring double quotes in parameter values. */
function parseContentLine(line: string): ContentLine | undefined {
  let i = delimiterAt(line, 0);
  if (i === 0 || i >= line.length) return undefined;
  const name = line.slice(0, i).toUpperCase();
  const params = new Map<string, string>();
  while (line[i] === ";") {
    i += 1;
    const eq = line.indexOf("=", i);
    if (eq < 0) return undefined;
    const key = line.slice(i, eq).toUpperCase();
    const read = readParamValue(line, eq + 1);
    if (read === undefined) return undefined;
    params.set(key, read.val);
    i = read.next;
  }
  if (line[i] !== ":") return undefined;
  return { name, params, value: line.slice(i + 1).trim() };
}

// The date part (weeks, days) and the time part (from `T`) are matched apart, one simple pattern each.
// Together they accept exactly `P[nW][nD][T[nH][nM][nS]]`.
const DURATION_DATE_RE = /^P(?:(\d+)W)?(?:(\d+)D)?(T.*)?$/;
const DURATION_TIME_RE = /^T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/;

export interface IcalDurationParts {
  /** Nominal calendar days (weeks x 7 + days). */
  readonly days: number;
  /** Exact milliseconds of the hour, minute and second part. */
  readonly ms: number;
}

/** An RFC 5545 DURATION split into nominal days and exact ms; a negative or malformed value is `undefined`. */
export function parseIcalDurationParts(raw: string): IcalDurationParts | undefined {
  const text = raw.trim().replace(/^\+/, "");
  const date = DURATION_DATE_RE.exec(text);
  if (date === null || text === "P" || text.endsWith("T")) return undefined;
  const [, w = "0", d = "0", timePart] = date;
  const time = timePart === undefined ? [] : DURATION_TIME_RE.exec(timePart);
  if (time === null) return undefined;
  const [, h = "0", mi = "0", s = "0"] = time;
  return {
    days: Number(w) * 7 + Number(d),
    ms: (Number(h) * 3_600 + Number(mi) * 60 + Number(s)) * 1000,
  };
}

/** An RFC 5545 DURATION in ms, every day counted as 24 hours; a negative or malformed value is `undefined`. */
export function parseIcalDurationMs(raw: string): number | undefined {
  const parts = parseIcalDurationParts(raw);
  return parts === undefined ? undefined : parts.days * 86_400_000 + parts.ms;
}

type Draft = {
  uid: string;
  recurrenceId: string;
  startTzid?: string | undefined;
  endTzid?: string | undefined;
  durationMs?: number | undefined;
  durationParts?: IcalDurationParts | undefined;
  partstat: Map<string, string>;
};

function applyLine(d: Draft, line: ContentLine): void {
  switch (line.name) {
    case "UID":
      d.uid = line.value;
      break;
    case "RECURRENCE-ID":
      d.recurrenceId = line.value;
      break;
    case "DTSTART":
      d.startTzid = line.params.get("TZID");
      break;
    case "DTEND":
      d.endTzid = line.params.get("TZID");
      break;
    case "DURATION":
      d.durationMs = parseIcalDurationMs(line.value);
      d.durationParts = parseIcalDurationParts(line.value);
      break;
    case "ATTENDEE": {
      const status = line.params.get("PARTSTAT")?.toLowerCase();
      const addr = line.value
        .replace(/^mailto:/i, "")
        .trim()
        .toLowerCase();
      if (status !== undefined && KNOWN_PARTSTATS.has(status) && addr !== "") {
        d.partstat.set(addr, status);
      }
      break;
    }
    default:
      break;
  }
}

function finishDraft(out: Map<string, IcalEventExtras>, d: Draft): void {
  if (d.uid === "") return;
  const key = d.recurrenceId === "" ? d.uid : `${d.uid}:${d.recurrenceId}`;
  if (out.has(key)) return;
  out.set(key, {
    startTzid: d.startTzid,
    endTzid: d.endTzid,
    durationMs: d.durationMs,
    durationParts: d.durationParts,
    partstatByAddress: d.partstat,
  });
}

export function parseIcalEventExtras(ics: string): ReadonlyMap<string, IcalEventExtras> {
  const out = new Map<string, IcalEventExtras>();
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  let draft: Draft | undefined;
  let nested = 0;
  for (const raw of lines) {
    const upper = raw.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      draft = { uid: "", recurrenceId: "", partstat: new Map() };
      nested = 0;
    } else if (draft === undefined) {
      // outside a VEVENT
    } else if (upper === "END:VEVENT") {
      finishDraft(out, draft);
      draft = undefined;
    } else if (upper.startsWith("BEGIN:")) {
      nested += 1;
    } else if (upper.startsWith("END:")) {
      nested = Math.max(0, nested - 1);
    } else if (nested === 0) {
      const line = parseContentLine(raw);
      if (line !== undefined) applyLine(draft, line);
    }
  }
  return out;
}
