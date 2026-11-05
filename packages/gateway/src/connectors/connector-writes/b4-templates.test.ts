// Phase 9.7 B4a: the typed previews of the calendar event creates and the Drive file create (plan
// R2). Each row's template keys are exactly its tool's input-schema keys in
// `@nimbus-dev/connectors` 0.4.0 (`connectors/outlook/src/tools.ts`,
// `connectors/apple/src/calendar-tools.ts`, `connectors/google-drive/src/tools.ts`), so the spec
// section 13 drift check offers it and, for well-formed input, `Other fields` is empty.
import { describe, expect, test } from "bun:test";

import { serviceOf } from "../../engine/service-of.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import {
  buildConnectorWritePreviewFrom,
  type ConnectorWritePreview,
  renderConnectorWritePreviewLines,
} from "./preview.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

const B4A_ROWS = [
  "outlook_calendar_create",
  "apple_calendar_event_create",
  "gdrive_file_create",
] as const;
type B4aRow = (typeof B4A_ROWS)[number];

/** The one wave-2 row still without a template: the Obsidian append (B4b). */
const UNTEMPLATED_WAVE_2 = ["obsidian_append_to_daily_note"];

/** The 0.4.0 input-schema keys of each row, spelled out from the connector source (sorted). */
const SCHEMA_KEYS: Readonly<Record<B4aRow, readonly string[]>> = {
  outlook_calendar_create: [
    "attendees",
    "body",
    "endDateTime",
    "startDateTime",
    "subject",
    "timeZone",
  ],
  apple_calendar_event_create: [
    "attendees",
    "calendar",
    "description",
    "end",
    "location",
    "start",
    "summary",
    "uid",
  ],
  gdrive_file_create: ["content", "mimeType", "name", "parentId"],
};

/** Well-formed input naming every schema key. */
const CLEAN: Readonly<Record<B4aRow, Record<string, unknown>>> = {
  outlook_calendar_create: {
    subject: "Design review",
    startDateTime: "2026-11-05T10:00:00",
    endDateTime: "2026-11-05T11:00:00",
    timeZone: "Europe/Paris",
    attendees: "a@x.com, b@y.com",
    body: "Agenda",
  },
  apple_calendar_event_create: {
    calendar: "Work",
    summary: "Design review",
    start: "20261105T100000Z",
    end: "20261105T110000Z",
    description: "Agenda",
    location: "Room 4",
    attendees: ["a@x.com", "b@y.com"],
    uid: "evt-1@example.com",
  },
  gdrive_file_create: {
    name: "notes.md",
    mimeType: "text/markdown",
    parentId: "F1",
    content: "# Notes",
  },
};

const GOLDEN: Readonly<Record<B4aRow, readonly string[]>> = {
  outlook_calendar_create: [
    "Service: outlook",
    "Credential: personal",
    "Target:  Design review",
    "Create an Outlook calendar event; Outlook emails an invitation to every attendee listed",
    "",
    '  Title: "Design review"',
    '  Start (in the time zone below): "2026-11-05T10:00:00"',
    '  End (in the time zone below): "2026-11-05T11:00:00"',
    '  Time zone: "Europe/Paris"',
    '  Attendees (each is emailed an invitation when the event is created): "a@x.com, b@y.com"',
    '  Description (plain text): "Agenda"',
  ],
  apple_calendar_event_create: [
    "Service: apple",
    "Credential: personal",
    "Target:  Design review",
    "Create an iCloud Calendar event; iCloud may email an invitation to every attendee listed",
    "",
    '  Title: "Design review"',
    '  Start (iCalendar time; a trailing Z means UTC): "20261105T100000Z"',
    '  End (iCalendar time; a trailing Z means UTC): "20261105T110000Z"',
    '  Calendar: "Work"',
    '  Attendees (each may be emailed an invitation): ["a@x.com","b@y.com"]',
    '  Location: "Room 4"',
    '  Description (plain text): "Agenda"',
    '  Event id (UID): "evt-1@example.com"',
  ],
  gdrive_file_create: [
    "Service: google_drive",
    "Credential: personal",
    "Target:  notes.md",
    "Create a Google Drive file named notes.md",
    "",
    '  File name: "notes.md"',
    '  Type: "text/markdown"',
    '  Folder id: "F1"',
    '  Content (sent as is, shown in full): "# Notes"',
  ],
};

function rowOf(toolId: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
}

function previewOf(toolId: B4aRow, input: Record<string, unknown>): ConnectorWritePreview {
  const r = rowOf(toolId);
  const p = buildConnectorWritePreviewFrom(
    {
      type: r.actionType,
      origin: "model",
      payload: { mcpToolId: mcpClientToolKey(serviceOf(r.actionType), toolId), input },
    },
    CONNECTOR_WRITE_ROWS,
    () => "personal",
  );
  if (p === undefined) throw new Error(`no preview for ${toolId}`);
  return p;
}

function fieldValue(p: ConnectorWritePreview, label: string): string | undefined {
  return p.fields.find((f) => f.label === label)?.value;
}

describe("B4a typed previews (plan R2)", () => {
  test("the B4a rows are exactly the calendar and Drive creates: mesh, wave 2, templated, offerable", () => {
    expect(B4A_ROWS).toHaveLength(3);
    for (const id of B4A_ROWS) {
      const r = rowOf(id);
      expect(r.transport, id).toBe("mesh");
      expect(r.wave, id).toBe(2);
      expect(r.preview, id).toBeDefined();
      expect(isModelOfferableRow(r), id).toBe(true);
    }
    // The wave-2 rows still without a template are then exactly the Obsidian append (B4b).
    expect(
      CONNECTOR_WRITE_ROWS.filter((r) => r.wave === 2 && r.preview === undefined)
        .map((r) => r.toolId)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(UNTEMPLATED_WAVE_2);
    expect(
      CONNECTOR_WRITE_ROWS.filter((r) => r.wave === 2 && !isModelOfferableRow(r)).map(
        (r) => r.toolId,
      ),
    ).toEqual(UNTEMPLATED_WAVE_2);
  });

  for (const id of B4A_ROWS) {
    test(`golden lines: ${id}`, () => {
      const p = previewOf(id, CLEAN[id]);
      expect(renderConnectorWritePreviewLines(p)).toEqual([...GOLDEN[id]]);
      expect(p.otherFields).toEqual([]);
    });
  }

  test("unset optional fields show their real default", () => {
    const outlook = previewOf("outlook_calendar_create", {
      subject: "S",
      startDateTime: "2026-11-05T10:00",
      endDateTime: "2026-11-05T11:00",
    });
    expect(fieldValue(outlook, "Time zone")).toBe("UTC");
    expect(
      fieldValue(outlook, "Attendees (each is emailed an invitation when the event is created)"),
    ).toBe("(not set: no one is invited)");
    expect(fieldValue(outlook, "Description (plain text)")).toBe("(not set: none)");

    const apple = previewOf("apple_calendar_event_create", {
      summary: "S",
      start: "20261105T100000Z",
      end: "20261105T110000Z",
    });
    expect(fieldValue(apple, "Calendar")).toBe(
      "(not set: the first calendar the connector's settings select)",
    );
    expect(fieldValue(apple, "Event id (UID)")).toBe("(not set: generated by the connector)");
    expect(fieldValue(apple, "Attendees (each may be emailed an invitation)")).toBe(
      "(not set: no one is invited)",
    );
    expect(fieldValue(apple, "Location")).toBe("(not set: none)");
    expect(fieldValue(apple, "Description (plain text)")).toBe("(not set: none)");

    const drive = previewOf("gdrive_file_create", { name: "n.txt" });
    expect(fieldValue(drive, "Type")).toBe("text/plain");
    expect(fieldValue(drive, "Folder id")).toBe("(not set: the root of My Drive)");
    expect(fieldValue(drive, "Content (sent as is, shown in full)")).toBe(
      "(not set: an empty file)",
    );
  });

  test("attendees are named: one Attendees line each, verbatim (Outlook) or compact JSON (iCloud)", () => {
    const outlookLabel = "Attendees (each is emailed an invitation when the event is created)";
    const outlook = renderConnectorWritePreviewLines(
      previewOf("outlook_calendar_create", { ...CLEAN.outlook_calendar_create }),
    );
    expect(outlook.filter((l) => l.startsWith(`  ${outlookLabel}: `))).toEqual([
      `  ${outlookLabel}: "a@x.com, b@y.com"`,
    ]);
    const appleLabel = "Attendees (each may be emailed an invitation)";
    const apple = renderConnectorWritePreviewLines(
      previewOf("apple_calendar_event_create", { ...CLEAN.apple_calendar_event_create }),
    );
    expect(apple.filter((l) => l.startsWith(`  ${appleLabel}: `))).toEqual([
      `  ${appleLabel}: ["a@x.com","b@y.com"]`,
    ]);
  });

  test("no attendee bound: 200 Outlook addresses and 50 iCloud ones are shown in full", () => {
    const many = Array.from({ length: 200 }, (_, i) => `p${String(i)}@example.com`).join(", ");
    const outlook = previewOf("outlook_calendar_create", {
      ...CLEAN.outlook_calendar_create,
      attendees: many,
    });
    expect(
      fieldValue(outlook, "Attendees (each is emailed an invitation when the event is created)"),
    ).toBe(JSON.stringify(many));
    const list = Array.from({ length: 50 }, (_, i) => `q${String(i)}@example.com`);
    const apple = previewOf("apple_calendar_event_create", {
      ...CLEAN.apple_calendar_event_create,
      attendees: list,
    });
    expect(fieldValue(apple, "Attendees (each may be emailed an invitation)")).toBe(
      JSON.stringify(list),
    );
  });

  test("a display name and a look-alike domain are shown as given, never resolved", () => {
    const given = '"CEO" <attacker@example.net>, ops@examp1e.com';
    const p = previewOf("outlook_calendar_create", {
      ...CLEAN.outlook_calendar_create,
      attendees: given,
    });
    expect(
      fieldValue(p, "Attendees (each is emailed an invitation when the event is created)"),
    ).toBe(JSON.stringify(given));
  });

  test("time zones are shown verbatim", () => {
    for (const tz of ["Pacific Standard Time", "Europe/Paris"]) {
      const p = previewOf("outlook_calendar_create", {
        ...CLEAN.outlook_calendar_create,
        timeZone: tz,
      });
      expect(fieldValue(p, "Time zone")).toBe(JSON.stringify(tz));
    }
  });

  test("Drive content is shown in full (owner ruling OR-B4-3)", () => {
    const content = "x".repeat(100_000);
    const p = previewOf("gdrive_file_create", { name: "big.txt", content });
    expect(fieldValue(p, "Content (sent as is, shown in full)")).toBe(JSON.stringify(content));
  });

  test("no field is markdown or secret: the owner sees the exact characters", () => {
    for (const id of B4A_ROWS) {
      for (const f of rowOf(id).preview?.fields ?? [])
        expect(f.kind, `${id}.${f.key}`).toBe("text");
    }
  });

  test("the drift keys equal the 0.4.0 schema keys", () => {
    for (const id of B4A_ROWS) {
      const t = rowOf(id).preview;
      if (t === undefined) throw new Error(id);
      expect(
        [...previewTemplateKeys(t)].sort((a, b) => a.localeCompare(b)),
        id,
      ).toEqual([...SCHEMA_KEYS[id]]);
    }
  });

  test("the calendar creates have no before-state (nothing exists yet)", () => {
    expect(rowOf("outlook_calendar_create").before).toBeUndefined();
    expect(rowOf("apple_calendar_event_create").before).toBeUndefined();
  });
});
