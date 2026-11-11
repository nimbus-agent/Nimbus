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
  /** Lower-cased attendee address -> a KNOWN PARTSTAT, lower-cased. An unknown value is ignored. */
  readonly partstatByAddress: ReadonlyMap<string, string>;
}

const KNOWN_PARTSTATS = new Set(["accepted", "declined", "tentative", "needs-action"]);

type ContentLine = {
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
};

/** Splits `NAME;P=V;Q="a:b":value`, honoring double quotes in parameter values. */
function parseContentLine(line: string): ContentLine | undefined {
  let i = 0;
  while (i < line.length && line[i] !== ";" && line[i] !== ":") i += 1;
  if (i === 0 || i >= line.length) return undefined;
  const name = line.slice(0, i).toUpperCase();
  const params = new Map<string, string>();
  while (line[i] === ";") {
    i += 1;
    const eq = line.indexOf("=", i);
    if (eq < 0) return undefined;
    const key = line.slice(i, eq).toUpperCase();
    i = eq + 1;
    let val = "";
    if (line[i] === '"') {
      const close = line.indexOf('"', i + 1);
      if (close < 0) return undefined;
      val = line.slice(i + 1, close);
      i = close + 1;
    } else {
      const start = i;
      while (i < line.length && line[i] !== ";" && line[i] !== ":") i += 1;
      val = line.slice(start, i);
    }
    params.set(key, val);
  }
  if (line[i] !== ":") return undefined;
  return { name, params, value: line.slice(i + 1).trim() };
}

const DURATION_RE = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** An RFC 5545 DURATION in ms; a negative or malformed value is `undefined`. */
export function parseIcalDurationMs(raw: string): number | undefined {
  const text = raw.trim().replace(/^\+/, "");
  const m = DURATION_RE.exec(text);
  if (m === null || text === "P" || text.endsWith("T")) return undefined;
  const [, w = "0", d = "0", h = "0", mi = "0", s = "0"] = m;
  const seconds =
    (Number(w) * 7 + Number(d)) * 86_400 + Number(h) * 3_600 + Number(mi) * 60 + Number(s);
  return seconds * 1000;
}

type Draft = {
  uid: string;
  recurrenceId: string;
  startTzid?: string | undefined;
  endTzid?: string | undefined;
  durationMs?: number | undefined;
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
