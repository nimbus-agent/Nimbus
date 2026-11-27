// The three Google Calendar event writes (`@nimbus-dev/connectors` 0.20.0): their rows (waves,
// HITL types, offer, confirm), their typed previews (golden lines, the notification line, the
// guest-list replacement), their drift keys against the installed connector's schemas, their
// before-state reader and update guard, their reversibility, their door refusals and their scope
// gate (the reader, the guard and the scope gate are in `google-calendar-readers.test.ts`).
import { describe, expect, test } from "bun:test";

import { HITL_REQUIRED } from "../../engine/executor.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type { ChatopsPolicy } from "../../policy/types.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { renderConfirmText } from "./confirm.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { installedToolsSource } from "./installed-schema-keys.test-helpers.ts";
import { isModelOfferableRow, MODEL_NEVER_OFFERED_TOOL_IDS } from "./model-offerable.ts";
import {
  messagingDestinationRefusal,
  modelWriteRefusal,
  nullOptionalFieldRefusal,
  nullRefusedOptionalKeys,
  remoteContentScannedKeys,
  scannedTextKeys,
} from "./model-write-refusals.ts";
import {
  buildConnectorWritePreviewFrom,
  type ConnectorWritePreview,
  renderConnectorWritePreviewLines,
} from "./preview.ts";
import { REVERSIBILITY_TABLE, reversibilityClassOf } from "./reversibility.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

const CREATE = "gcal_event_create";
const UPDATE = "gcal_event_update";
const DELETE = "gcal_event_delete";
const IDS = [CREATE, UPDATE, DELETE] as const;
const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };

function rowOf(id: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === id);
  if (r === undefined) throw new Error(`no row ${id}`);
  return r;
}

function previewOf(id: string, input: Record<string, unknown>): ConnectorWritePreview {
  const r = rowOf(id);
  const p = buildConnectorWritePreviewFrom(
    {
      type: r.actionType,
      origin: "model",
      payload: { mcpToolId: mcpClientToolKey(serviceOf(r.actionType), id), input },
    },
    CONNECTOR_WRITE_ROWS,
    () => "personal",
  );
  if (p === undefined) throw new Error(`no preview for ${id}`);
  return p;
}

/** Both door entry points give the same answer (the rule is in the shared check). */
function onBothDoors(id: string, input: Readonly<Record<string, unknown>>): string | undefined {
  const messaging = messagingDestinationRefusal(id, input, { chatops: NO_CHATOPS });
  expect(modelWriteRefusal(id, input, { chatops: NO_CHATOPS, kb: undefined })).toBe(messaging);
  return messaging;
}

/**
 * The top-level keys of the `z.object({ ... })` declared as `const <name> =` in `src`, shorthand
 * properties (`summary,`) included. Throws when the declaration is missing.
 */
function schemaKeys(src: string, name: string): readonly string[] {
  const anchor = `const ${name} = z.object({`;
  const at = src.indexOf(anchor);
  if (at === -1) throw new Error(`anchor not found: ${anchor}`);
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = at + anchor.length; i < src.length; i++) {
    const ch = src[i] ?? "";
    if (depth === 0 && ch === "}") break;
    if ("({[".includes(ch)) depth++;
    if (")}]".includes(ch)) depth--;
    if (depth === 0 && ch === ",") {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments.flatMap((s) => {
    const m = /^\s*([A-Za-z_]\w*)/.exec(s);
    return m?.[1] === undefined ? [] : [m[1]];
  });
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort((a, b) => a.localeCompare(b));

const TIMED = {
  start: { dateTime: "2026-12-01T09:00:00+01:00", timeZone: "Europe/Berlin" },
  end: { dateTime: "2026-12-01T09:15:00+01:00", timeZone: "Europe/Berlin" },
};
const CREATE_MIN = { summary: "Standup", ...TIMED };

describe("Google Calendar writes: the rows", () => {
  test("create and update are Wave 2, delete Wave 4; mesh rows under their own frozen HITL types, all offerable", () => {
    const waves = IDS.map((id) => rowOf(id).wave);
    expect(waves).toEqual([2, 2, 4]);
    for (const id of IDS) {
      const r = rowOf(id);
      expect(r.actionType, id).toBe(`google_calendar.event.${id.slice("gcal_event_".length)}`);
      expect(serviceOf(r.actionType), id).toBe("google_calendar");
      expect(r.transport, id).toBe("mesh");
      expect(HITL_REQUIRED.has(r.actionType), id).toBe(true);
      expect(isModelOfferableRow(r), id).toBe(true);
      expect(MODEL_NEVER_OFFERED_TOOL_IDS.has(id), id).toBe(false);
      expect(r.bound, id).toBeUndefined();
    }
  });

  test("only the delete has a confirm text: delete and the WHOLE event id", () => {
    expect(rowOf(CREATE).confirm).toBeUndefined();
    expect(rowOf(UPDATE).confirm).toBeUndefined();
    expect(rowOf(DELETE).confirm?.template).toBe("delete {eventId}");
    expect(
      renderConfirmText(rowOf(DELETE), { eventId: "abc123def456", sendUpdates: "all" }),
    ).toEqual({ ok: true, text: "google_calendar/delete abc123def456" });
  });

  // An occurrence id is `<seriesId>_<YYYYMMDDTHHMMSSZ>` (all day: `<seriesId>_<YYYYMMDD>`), as
  // gcal_event_list returns them, so the last 8 characters are only the time of day.
  test("occurrences on different days, and different series at the same time, confirm differently", () => {
    const confirmOf = (eventId: string): string => {
      const r = renderConfirmText(rowOf(DELETE), { eventId });
      if (!r.ok) throw new Error(`${eventId}: ${r.reason}`);
      return r.text;
    };
    const ids = [
      "abc123series_20261201T090000Z",
      "abc123series_20261208T090000Z",
      "zzz999other_20261201T090000Z",
      "abc123series_20261201",
      "abc123series_20261208",
    ];
    const texts = ids.map(confirmOf);
    expect(new Set(texts).size).toBe(ids.length);
    for (const [i, id] of ids.entries()) expect(texts[i]).toBe(`google_calendar/delete ${id}`);
    // An id too long to type is refused, never cut to a tail.
    expect(renderConfirmText(rowOf(DELETE), { eventId: "a".repeat(300) }).ok).toBe(false);
  });

  test("update and delete are irreversible with a reason; the create has no entry (unknown)", () => {
    for (const id of [UPDATE, DELETE]) {
      const decl = REVERSIBILITY_TABLE[id]?.decl;
      expect(decl?.class, id).toBe("irreversible");
      expect(decl?.class === "irreversible" && decl.reason.length > 0, id).toBe(true);
    }
    expect(REVERSIBILITY_TABLE[CREATE]).toBeUndefined();
    expect(reversibilityClassOf(rowOf(CREATE))).toBe("unknown");
  });

  test("each template's keys are exactly the installed connector's schema keys", () => {
    const src = installedToolsSource("google-calendar");
    const schemas: Readonly<Record<string, string>> = {
      [CREATE]: "eventCreateArgs",
      [UPDATE]: "eventUpdateArgs",
      [DELETE]: "eventDeleteArgs",
    };
    for (const id of IDS) {
      expect(src, id).toContain(`"${id}"`);
      const t = rowOf(id).preview;
      if (t === undefined) throw new Error(id);
      expect(sorted(previewTemplateKeys(t)), id).toEqual(
        sorted(schemaKeys(src, schemas[id] ?? "")),
      );
    }
    // Not vacuous: the reader sees the shorthand keys too.
    expect(schemaKeys(src, "eventCreateArgs")).toContain("sendUpdates");
    expect(schemaKeys(src, "eventDeleteArgs")).toEqual(["calendarId", "eventId", "sendUpdates"]);
    expect(() => schemaKeys(src, "noSuchSchema")).toThrow(/anchor not found/);
  });

  test("no field is markdown or secret: the owner sees the exact characters", () => {
    for (const id of IDS) {
      for (const f of rowOf(id).preview?.fields ?? [])
        expect(f.kind, `${id}.${f.key}`).toBe("text");
    }
  });
});

const NOTIFY = (about: string): string =>
  `Who Google emails about ${about} (sendUpdates: "none" asks it to email no guest, though Google may still send some; "externalOnly" emails only guests not on Google Calendar; "all" emails every guest)`;
const NOTIFY_UNSET =
  '(not set: "none", Google is asked to email no guest, though it may still send some)';
const EVENT_ID =
  "Event id (a recurring series' id acts on EVERY occurrence; an instance id, as gcal_event_list returns, on that one occurrence)";

describe("Google Calendar writes: the typed previews", () => {
  test("golden lines: a timed create with nothing optional set", () => {
    const p = previewOf(CREATE, CREATE_MIN);
    expect(renderConnectorWritePreviewLines(p)).toEqual([
      "Service: google_calendar",
      "Credential: personal",
      "Target:  Standup",
      "Create a Google Calendar event; whether Google emails the guests is the Notifications line",
      "",
      "  Calendar: (not set: primary, your main calendar)",
      '  Title: "Standup"',
      '  Start ({dateTime with its UTC offset, timeZone} for a timed event, {date} for all day): {"dateTime":"2026-12-01T09:00:00+01:00","timeZone":"Europe/Berlin"}',
      '  End (an all-day end date is exclusive: the event ends the day before it): {"dateTime":"2026-12-01T09:15:00+01:00","timeZone":"Europe/Berlin"}',
      "  Guests (each is added to the event, as written here): (not set: no guests)",
      "  Repeats (iCalendar RRULE, EXRULE, RDATE and EXDATE lines): (not set: a single event, not recurring)",
      "  Location: (not set: none)",
      "  Description: (not set: none)",
      `  ${NOTIFY("the new event")}: ${NOTIFY_UNSET}`,
    ]);
    expect(p.otherFields).toEqual([]);
  });

  test("a create with guests, recurrence and sendUpdates shows each verbatim", () => {
    const p = previewOf(CREATE, {
      ...CREATE_MIN,
      calendarId: "team@group.calendar.google.com",
      attendees: ["a@example.com", "b@example.org"],
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      location: "Room 1",
      description: "Agenda",
      sendUpdates: "all",
    });
    const value = (label: string) => p.fields.find((f) => f.label === label)?.value;
    expect(value("Calendar")).toBe('"team@group.calendar.google.com"');
    expect(value("Guests (each is added to the event, as written here)")).toBe(
      '["a@example.com","b@example.org"]',
    );
    expect(value("Repeats (iCalendar RRULE, EXRULE, RDATE and EXDATE lines)")).toBe(
      '["RRULE:FREQ=WEEKLY;BYDAY=MO"]',
    );
    expect(value(NOTIFY("the new event"))).toBe('"all"');
    expect(p.otherFields).toEqual([]);
  });

  test("golden lines: an update says that attendees replaces the whole guest list", () => {
    const p = previewOf(UPDATE, {
      eventId: "abc123def456",
      attendees: ["a@example.com"],
      sendUpdates: "externalOnly",
    });
    expect(renderConnectorWritePreviewLines(p)).toEqual([
      "Service: google_calendar",
      "Credential: personal",
      "Target:  abc123def456",
      "Change Google Calendar event abc123def456: only the fields set below change; Nimbus cannot undo it",
      "",
      `  ${EVENT_ID}: "abc123def456"`,
      "  Calendar: (not set: primary, your main calendar)",
      "  New title: (not set: unchanged)",
      "  New start: (not set: unchanged)",
      "  New end: (not set: unchanged)",
      '  New guest list (REPLACES the whole list: every guest not named here is removed, and [] removes every guest): ["a@example.com"]',
      "  New recurrence (replaces the event's recurrence lines): (not set: unchanged)",
      "  New location: (not set: unchanged)",
      "  New description (replaces the whole description, which is not shown): (not set: unchanged)",
      `  ${NOTIFY("the change")}: "externalOnly"`,
    ]);
    expect(p.otherFields).toEqual([]);
  });

  test("golden lines: a delete names the series effect and the cancellation notifications", () => {
    const p = previewOf(DELETE, { eventId: "abc123def456" });
    expect(renderConnectorWritePreviewLines(p)).toEqual([
      "Service: google_calendar",
      "Credential: personal",
      "Target:  abc123def456",
      "Delete Google Calendar event abc123def456; Nimbus cannot undo it",
      "",
      `  ${EVENT_ID}: "abc123def456"`,
      "  Calendar: (not set: primary, your main calendar)",
      `  ${NOTIFY("the cancellation")}: ${NOTIFY_UNSET}`,
    ]);
  });
});

describe("Google Calendar writes: door refusals (the Outlook calendar rows' precedent)", () => {
  test("a clean create, update and delete are allowed", () => {
    expect(onBothDoors(CREATE, CREATE_MIN)).toBeUndefined();
    expect(onBothDoors(UPDATE, { eventId: "e", summary: "x", sendUpdates: "all" })).toBeUndefined();
    expect(onBothDoors(DELETE, { eventId: "e", calendarId: "primary" })).toBeUndefined();
  });

  test("every optional key's null is refused before the prompt, naming the key; undefined is unset", () => {
    const base: Readonly<Record<string, Record<string, unknown>>> = {
      [CREATE]: CREATE_MIN,
      [UPDATE]: { eventId: "e", summary: "x" },
      [DELETE]: { eventId: "e" },
    };
    expect(nullRefusedOptionalKeys(CREATE)).toEqual([
      "calendarId",
      "description",
      "location",
      "attendees",
      "recurrence",
      "sendUpdates",
    ]);
    expect(nullRefusedOptionalKeys(UPDATE)).toEqual([
      "calendarId",
      "summary",
      "description",
      "location",
      "start",
      "end",
      "attendees",
      "recurrence",
      "sendUpdates",
    ]);
    expect(nullRefusedOptionalKeys(DELETE)).toEqual(["calendarId", "sendUpdates"]);
    for (const id of IDS) {
      for (const key of nullRefusedOptionalKeys(id)) {
        const input = { ...base[id], [key]: null };
        expect(onBothDoors(id, input), `${id}.${key}`).toBe(nullOptionalFieldRefusal(key));
        expect(onBothDoors(id, { ...base[id], [key]: undefined }), `${id}.${key}`).toBeUndefined();
      }
    }
  });

  // Stated bounds, as the Outlook and iCloud calendar rows: no BroadcastService rule (a calendar has
  // no whole-group mention; every guest is in the preview) and no remote-content scan of a calendar
  // description (owner ruling; Google may render some HTML there).
  test("not scanned for broadcast mentions or remote content (stated bounds)", () => {
    for (const id of IDS) {
      expect(scannedTextKeys(id), id).toEqual([]);
      expect(remoteContentScannedKeys(id), id).toEqual([]);
    }
    expect(
      onBothDoors(CREATE, { ...CREATE_MIN, summary: "@all", description: "<img src=x>" }),
    ).toBeUndefined();
  });
});
