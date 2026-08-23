// Connector contract test for the apple connector. Locks the public tool
// surface (exactly APPLE_TOOL_NAMES) and the metadata-only privacy invariant:
// apple_list / apple_get expose ONLY headers + attachment METADATA + a capped
// preview — never a full body or attachment bytes — and apple_calendar_list
// caps event notes at 2000 chars while still surfacing attendee emails.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { EmailMessageMeta } from "../src/apple-mail-core.ts";
import type { CalDavClient } from "../src/caldav-core.ts";
import { APPLE_TOOL_NAMES, registerAppleTools } from "../src/tools.ts";

// Contract cases assert the TOOL SURFACE, not the consent gate, against a minimal fake server.
// Gateway mode is the shape they were written against. Reset on BOTH sides — bun test runs many
// files in ONE process.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
});
afterEach(() => {
  resetConnectorModeForTests();
});

function stubServer() {
  const tools: Record<string, (input: unknown) => Promise<unknown>> = {};
  return {
    server: {
      registerTool: (
        name: string,
        _cfg: unknown,
        cb: (i: unknown) => Promise<unknown>,
      ): { disable: () => void } => {
        tools[name] = cb;
        return { disable: () => undefined };
      },
      tool: (
        name: string,
        _desc: string,
        _schema: unknown,
        cb: (i: unknown) => Promise<unknown>,
      ) => {
        tools[name] = cb;
      },
    },
    tools,
  };
}

function parseResult(result: unknown): unknown {
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray((result as { content: unknown[] }).content)
  ) {
    const first = (result as { content: { type: string; text: string }[] }).content[0];
    if (first?.type === "text") {
      return JSON.parse(first.text) as unknown;
    }
  }
  return result;
}

// A message whose preview is already capped at 2000 (the real server.ts caps via
// capPreview) and which carries attachment METADATA but no bytes/body anywhere.
const CAPPED_PREVIEW = "p".repeat(2000);
const META: EmailMessageMeta = {
  uid: 42,
  mailbox: "INBOX",
  uidValidity: "1",
  envelope: {
    date: "2026-06-01T09:00:00.000Z",
    subject: "Quarterly report",
    messageId: "<abc@icloud.com>",
    from: [{ name: "Boss", address: "boss@icloud.com" }],
    to: [{ name: "Me", address: "me@icloud.com" }],
    cc: [],
  },
  attachments: [{ filename: "report.pdf", sizeBytes: 12345, mimeType: "application/pdf" }],
  preview: CAPPED_PREVIEW,
};

const FORBIDDEN_BODY_KEYS = ["body", "raw", "bytes", "content", "html", "text", "source"];

function fakeCalendar(): CalDavClient {
  return {
    listCalendars: async () => [
      { url: "https://caldav.icloud.com/calendars/work", displayName: "Work" },
    ],
    listEvents: async () => [
      {
        href: "/calendars/work/e1.ics",
        event: {
          uid: "event-1",
          recurrenceId: null,
          summary: "Standup",
          description: "N".repeat(5000),
          location: "Room 4",
          start: "20260601T090000Z",
          end: "20260601T091500Z",
          allDay: false,
          status: "CONFIRMED",
          organizer: "boss@icloud.com",
          attendees: ["a@icloud.com", "b@icloud.com"],
          rrule: null,
          dtstamp: "20260601T000000Z",
        },
      },
    ],
    putEvent: async (_cal, uid) => ({ href: `/calendars/work/${uid}.ics` }),
    deleteEvent: async () => {},
  };
}

function register() {
  const { server, tools } = stubServer();
  registerAppleTools(server as never, {
    client: {
      list: async () => [META],
      get: async () => META,
      search: async () => [META],
    },
    mailer: { send: async () => ({ messageId: null, accepted: [], rejected: [] }) },
    draftAppender: { appendDraft: async () => ({ uid: null, mailbox: "Drafts" }) },
    calendar: fakeCalendar(),
    now: () => "20260601T000000Z",
  });
  return tools;
}

describe("apple connector contract — tool surface", () => {
  it("registers exactly APPLE_TOOL_NAMES (no more, no fewer)", () => {
    const tools = register();
    expect(Object.keys(tools).sort((a, b) => a.localeCompare(b))).toEqual(
      [...APPLE_TOOL_NAMES].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("APPLE_TOOL_NAMES has no duplicates", () => {
    expect(new Set(APPLE_TOOL_NAMES).size).toBe(APPLE_TOOL_NAMES.length);
  });
});

describe("apple connector contract — metadata-only mail invariant", () => {
  it("apple_list emits headers + attachment metadata + capped preview, never a body/bytes", async () => {
    const tools = register();
    const res = parseResult(await tools.apple_list({})) as { items: Record<string, unknown>[] };
    expect(res.items).toHaveLength(1);
    const view = res.items[0] ?? {};

    // Headers present.
    expect(view["subject"]).toBe("Quarterly report");
    expect(view["from"]).toEqual(["Boss <boss@icloud.com>"]);

    // Preview present + capped.
    expect(typeof view["preview"]).toBe("string");
    expect((view["preview"] as string).length).toBeLessThanOrEqual(2000);

    // No full-body / raw-bytes leak anywhere on the view.
    for (const k of FORBIDDEN_BODY_KEYS) {
      expect(view).not.toHaveProperty(k);
    }

    // Attachments are METADATA only — filename/size/mimetype, never bytes.
    const atts = view["attachments"] as Record<string, unknown>[];
    expect(atts).toHaveLength(1);
    expect(atts[0]).toEqual({
      filename: "report.pdf",
      sizeBytes: 12345,
      mimeType: "application/pdf",
    });
    expect(atts[0]).not.toHaveProperty("data");
    expect(atts[0]).not.toHaveProperty("bytes");
    expect(atts[0]).not.toHaveProperty("content");
  });

  it("apple_get emits a single metadata-only view, never a body/bytes", async () => {
    const tools = register();
    const res = parseResult(await tools.apple_get({ uid: 42 })) as {
      item: Record<string, unknown>;
    };
    expect(res.item["subject"]).toBe("Quarterly report");
    for (const k of FORBIDDEN_BODY_KEYS) {
      expect(res.item).not.toHaveProperty(k);
    }
    const atts = res.item["attachments"] as Record<string, unknown>[];
    expect(atts[0]).not.toHaveProperty("data");
  });
});

describe("apple connector contract — calendar privacy bounds", () => {
  it("apple_calendar_list caps notes at 2000 chars and includes attendee emails", async () => {
    const tools = register();
    const res = parseResult(
      await tools.apple_calendar_list({ startUtc: "20260601T000000Z", endUtc: "20260601T235959Z" }),
    ) as { items: { notes: string; attendees: string[] }[] };
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.notes).toHaveLength(2000);
    expect(res.items[0]?.attendees).toEqual(["a@icloud.com", "b@icloud.com"]);
  });
});
