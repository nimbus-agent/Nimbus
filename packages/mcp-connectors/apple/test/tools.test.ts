import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { CalDavClient } from "../src/caldav-core.ts";
import { APPLE_TOOL_NAMES, registerAppleTools } from "../src/tools.ts";

// These cases exercise the TOOL SURFACE, not the consent gate, and pass a minimal fake server.
// Gateway mode is the shape they were written against: the connector registers everything and
// executor.ts (I2) is the gate there. Reset on BOTH sides — bun test runs many files in ONE
// process, so an unreset lock would change every file that runs after this one.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
});
afterEach(() => {
  resetConnectorModeForTests();
});

/**
 * Minimal stub MCP server that captures registered tool handlers keyed by name.
 * Mirrors the pattern from imap/test/tools.test.ts — the server.tool signature
 * is (name, description, inputShape, handler) per createRegisterSimpleTool.
 */
function stubServer() {
  const tools: Record<string, (input: unknown) => Promise<unknown>> = {};
  return {
    server: {
      // The consent kit registers through `registerTool`, which returns a handle; the deprecated
      // `tool` below is what the read tools still use. Both record into the same map.
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

/** Parse the JSON payload from an mcpJsonResult content envelope. */
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

/** Minimal fake CalDavClient for tool-registration tests. */
function fakeCalendar(overrides?: Partial<CalDavClient>): {
  client: CalDavClient;
  putCalls: { uid: string; ics: string }[];
  deleteCalls: string[];
} {
  const putCalls: { uid: string; ics: string }[] = [];
  const deleteCalls: string[] = [];
  const client: CalDavClient = {
    listCalendars: async () => [
      { url: "https://caldav.icloud.com/calendars/work", displayName: "Work" },
    ],
    listEvents: async () => [],
    putEvent: async (_cal, uid, ics) => {
      putCalls.push({ uid, ics });
      return { href: `/calendars/work/${uid}.ics` };
    },
    deleteEvent: async (href) => {
      deleteCalls.push(href);
    },
    ...overrides,
  };
  return { client, putCalls, deleteCalls };
}

describe("registerAppleTools (mail)", () => {
  it("registers mail tools + draft tool and routes to injected client/mailer/draftAppender", async () => {
    const { server, tools } = stubServer();
    const sent: unknown[] = [];
    const drafted: unknown[] = [];
    const { client: calClient } = fakeCalendar();

    registerAppleTools(server as never, {
      client: {
        list: async () => [],
        get: async () => null,
        search: async () => [],
      },
      mailer: {
        send: async (i) => {
          sent.push(i);
          return { messageId: "m1", accepted: ["x@y.z"], rejected: [] };
        },
      },
      draftAppender: {
        appendDraft: async (i) => {
          drafted.push(i);
          return { uid: 3, mailbox: "Drafts" };
        },
      },
      calendar: calClient,
      now: () => "20260601T000000Z",
    });

    // The four shared email tools must be registered.
    expect(typeof tools.apple_list).toBe("function");
    expect(typeof tools.apple_get).toBe("function");
    expect(typeof tools.apple_search).toBe("function");
    expect(typeof tools.apple_mail_send).toBe("function");
    // The iCloud-specific draft tool must be registered.
    expect(typeof tools.apple_mail_draft_create).toBe("function");

    // apple_mail_send routes to the injected mailer.
    await tools.apple_mail_send({ to: "x@y.z", subject: "s", body: "b" });
    expect(sent).toHaveLength(1);

    // apple_mail_draft_create routes to draftAppender and returns { item: {uid, mailbox} }.
    const rawDraftRes = await tools.apple_mail_draft_create({
      to: "x@y.z",
      subject: "s",
      body: "b",
    });
    expect(drafted).toHaveLength(1);
    const draftRes = parseResult(rawDraftRes);
    expect(draftRes).toMatchObject({ item: { uid: 3, mailbox: "Drafts" } });
  });

  it("apple_mail_draft_create passes cc/bcc when provided", async () => {
    const { server, tools } = stubServer();
    const drafted: unknown[] = [];
    const { client: calClient } = fakeCalendar();

    registerAppleTools(server as never, {
      client: { list: async () => [], get: async () => null, search: async () => [] },
      mailer: {
        send: async () => ({ messageId: null, accepted: [], rejected: [] }),
      },
      draftAppender: {
        appendDraft: async (i) => {
          drafted.push(i);
          return { uid: 5, mailbox: "Drafts" };
        },
      },
      calendar: calClient,
      now: () => "20260601T000000Z",
    });

    await tools.apple_mail_draft_create({
      to: "a@b.c",
      subject: "hello",
      body: "world",
      cc: "cc@b.c",
      bcc: "bcc@b.c",
    });
    expect(drafted).toHaveLength(1);
    expect(drafted[0]).toMatchObject({
      to: "a@b.c",
      subject: "hello",
      body: "world",
      cc: "cc@b.c",
      bcc: "bcc@b.c",
    });
  });
});

describe("registerAppleTools (all 8 tools — Task C3)", () => {
  it("registers all APPLE_TOOL_NAMES when calendar + now are provided", () => {
    const { server, tools } = stubServer();
    const { client: calClient } = fakeCalendar();

    registerAppleTools(server as never, {
      client: { list: async () => [], get: async () => null, search: async () => [] },
      mailer: { send: async () => ({ messageId: null, accepted: [], rejected: [] }) },
      draftAppender: { appendDraft: async () => ({ uid: null, mailbox: "Drafts" }) },
      calendar: calClient,
      now: () => "20260601T000000Z",
    });

    for (const name of APPLE_TOOL_NAMES) {
      expect(typeof tools[name]).toBe("function");
    }
    expect(Object.keys(tools)).toHaveLength(APPLE_TOOL_NAMES.length);
  });

  it("apple_calendar_event_create routes to the fake CalDavClient.putEvent", async () => {
    const { server, tools } = stubServer();
    const { client: calClient, putCalls } = fakeCalendar();

    registerAppleTools(server as never, {
      client: { list: async () => [], get: async () => null, search: async () => [] },
      mailer: { send: async () => ({ messageId: null, accepted: [], rejected: [] }) },
      draftAppender: { appendDraft: async () => ({ uid: null, mailbox: "Drafts" }) },
      calendar: calClient,
      now: () => "20260601T000000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_event_create({
        summary: "Integration check",
        start: "20260601T100000Z",
        end: "20260601T110000Z",
        uid: "c3-uid-001",
      }),
    ) as { uid: string; href: string };

    expect(result.uid).toBe("c3-uid-001");
    expect(result.href).toBeTruthy();
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.uid).toBe("c3-uid-001");
  });

  it("apple_calendar_event_delete routes to the fake CalDavClient.deleteEvent", async () => {
    const { server, tools } = stubServer();
    const { client: calClient, deleteCalls } = fakeCalendar();

    registerAppleTools(server as never, {
      client: { list: async () => [], get: async () => null, search: async () => [] },
      mailer: { send: async () => ({ messageId: null, accepted: [], rejected: [] }) },
      draftAppender: { appendDraft: async () => ({ uid: null, mailbox: "Drafts" }) },
      calendar: calClient,
      now: () => "20260601T000000Z",
    });

    const result = parseResult(
      await tools.apple_calendar_event_delete({
        href: "/calendars/work/c3-uid-001.ics",
      }),
    ) as { deleted: boolean };

    expect(result.deleted).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toBe("/calendars/work/c3-uid-001.ics");
  });
});
