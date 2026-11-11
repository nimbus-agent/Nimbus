/**
 * Slack paths the existing suites do not reach: a `conversations.list` page whose `channels` field
 * is not an array (the ids gathered on earlier pages must survive it), and a
 * `conversations.history` page with no `response_metadata` at all (the channel is finished and the
 * walk moves to the next one, rather than treating the absent cursor as a page to fetch).
 *
 * The token comes through the context's own `accessToken` capability — no `mock.module` on the
 * Slack token getter — and `fetch` is a routing stub, so no request leaves the process.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import { listChatReadMarkers, setChatReadMarkerRows } from "../index/chat-read-marker-store.ts";
import type { SyncContext, SyncResult } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { createSlackSyncable } from "./slack-sync.ts";

const CURSOR_PREFIX = "nimbus-slk1:";
const LIST_URL = "https://slack.com/api/conversations.list";
const HISTORY_URL = "https://slack.com/api/conversations.history";
const AUTH_URL = "https://slack.com/api/auth.test";
const INFO_URL = "https://slack.com/api/conversations.info";
const FLOOR_TS = "1700000000.000000";

let fetchStub: StubFetch;
let db: Database;

beforeEach(() => {
  fetchStub = new StubFetch();
  fetchStub.install();
  db = createMemoryIndexDb();
});

afterEach(() => {
  fetchStub.restore();
  db.close();
});

function ctx(): SyncContext {
  return {
    ...syncTestContext(db, createStubVault({ "slack.oauth": "stored-oauth-blob" }), "slack"),
    accessToken: () => Promise.resolve("xoxb-test"),
  };
}

/** A cursor carrying `teamSubdomain`, so the sync skips its `auth.test` round-trip. */
function cursor(fields: {
  phase: "list" | "history";
  ids: string[];
  nextIdx?: number;
  listCursor?: string | null;
  hw?: Record<string, string | null>;
  mkIdx?: number;
  selfUserId?: string | null;
  /** Omit the MB4 fields, as a cursor written by an older gateway does. */
  legacy?: boolean;
}): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, {
    phase: fields.phase,
    floorTs: FLOOR_TS,
    ids: fields.ids,
    nextIdx: fields.nextIdx ?? 0,
    hw: fields.hw ?? {},
    listCursor: fields.listCursor ?? null,
    histCursor: null,
    teamSubdomain: "acme",
    ...(fields.legacy === true
      ? {}
      : { mkIdx: fields.mkIdx ?? 0, selfUserId: fields.selfUserId ?? null }),
  });
}

/**
 * Answers auth.test and conversations.info. StubFetch routes match on the URL only, so the per-channel
 * info replies are served by a wrapper that reads the request body; a string reply is a Slack error code.
 */
function markerRoutes(
  channels: Record<string, Record<string, unknown> | string>,
  selfId = "U9",
): { infoChannels: string[] } {
  fetchStub.respond("POST", AUTH_URL, {
    ok: true,
    user_id: selfId,
    url: "https://acme.slack.com/",
  });
  const infoChannels: string[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== INFO_URL) return inner(input, init);
    fetchStub.calls.push({ url, method: "POST", headers: {} });
    const body = JSON.parse(String(init?.body)) as { channel: string };
    infoChannels.push(body.channel);
    const reply = channels[body.channel];
    if (reply === undefined) return Promise.reject(new Error(`no info route for ${body.channel}`));
    return Promise.resolve(
      Response.json(
        typeof reply === "string"
          ? { ok: false, error: reply }
          : { ok: true, channel: { id: body.channel, ...reply } },
      ),
    );
  }) as unknown as typeof fetch;
  return { infoChannels };
}

function emptyHistory(): void {
  fetchStub.respond("POST", HISTORY_URL, { ok: true, messages: [], response_metadata: {} });
}

function sync(c: string): Promise<SyncResult> {
  return createSlackSyncable({ ensureSlackMcpRunning: async () => {} }).sync(ctx(), c);
}

function slackRows(): { external_id: string; url: string | null }[] {
  return db
    .query("SELECT external_id, url FROM item WHERE service = 'slack' ORDER BY external_id")
    .all() as { external_id: string; url: string | null }[];
}

describe("slack-sync — a channel list page whose `channels` is not an array", () => {
  test("keeps the ids from earlier pages and goes straight on to their history", async () => {
    fetchStub.respond("POST", LIST_URL, {
      ok: true,
      // A lone member channel OBJECT that would be collected on its own, so walking only C0
      // proves the field was ignored rather than read as a one-entry list.
      channels: { id: "C9", is_member: true },
      response_metadata: { next_cursor: "" },
    });
    fetchStub.respond("POST", HISTORY_URL, {
      ok: true,
      messages: [{ ts: "1700000100.000200", text: "standup notes", user: "U1" }],
      response_metadata: { next_cursor: "" },
    });

    markerRoutes({ C0: { last_read: "1700000050.000000" } });

    const res = await sync(cursor({ phase: "list", ids: ["C0"], listCursor: "page-2" }));

    // C0 is the only channel, so this call also ends the round: the marker pass follows the history.
    expect(fetchStub.calls.map((c) => c.url)).toEqual([LIST_URL, HISTORY_URL, AUTH_URL, INFO_URL]);
    expect(res.itemsUpserted).toBe(1);
    expect(res.hasMore).toBe(false);
    // Only the channel carried in from the earlier page was walked — never the lone object's C9.
    expect(slackRows().map((r) => r.external_id)).toEqual(["C0:1700000100.000200"]);
    // The round is over, so the cursor goes back to the list phase to re-list next time. The list
    // page had no channels array: it is marked partial, so the marker pass did not prune.
    expect(decodeNimbusJsonCursorObject(res.cursor, CURSOR_PREFIX)).toMatchObject({
      phase: "list",
      ids: [],
      nextIdx: 0,
      listCursor: null,
      listPartial: false,
    });
  });
});

describe("slack-sync — a history page with no response_metadata", () => {
  test("finishes the channel: high-water mark recorded, walk advances to the next channel", async () => {
    fetchStub.respond("POST", HISTORY_URL, {
      ok: true,
      messages: [
        { ts: "1700000200.000300", text: "deploy done", user: "U2" },
        { ts: "1700000100.000100", text: "earlier", user: "U2" },
      ],
    });

    const res = await sync(cursor({ phase: "history", ids: ["C1", "C2"] }));

    expect(fetchStub.calls.map((c) => c.url)).toEqual([HISTORY_URL]);
    expect(res.itemsUpserted).toBe(2);
    // C2 is still to come, so the run reports more work rather than a finished walk.
    expect(res.hasMore).toBe(true);
    expect(decodeNimbusJsonCursorObject(res.cursor, CURSOR_PREFIX)).toMatchObject({
      phase: "history",
      ids: ["C1", "C2"],
      nextIdx: 1,
      histCursor: null,
      hw: { C1: "1700000200.000300" },
    });
    expect(slackRows()).toEqual([
      {
        external_id: "C1:1700000100.000100",
        url: "https://acme.slack.com/archives/C1/p1700000100000100",
      },
      {
        external_id: "C1:1700000200.000300",
        url: "https://acme.slack.com/archives/C1/p1700000200000300",
      },
    ]);
  });
});

function cursorOf(res: SyncResult): Record<string, unknown> {
  return decodeNimbusJsonCursorObject(res.cursor, CURSOR_PREFIX) ?? {};
}

describe("slack-sync - which conversations are indexed", () => {
  test("a direct message and a group DM (no is_member) are collected; a non-member channel is not", async () => {
    fetchStub.respond("POST", LIST_URL, {
      ok: true,
      channels: [
        { id: "D1", is_im: true },
        { id: "G1", is_mpim: true },
        { id: "C2", is_member: false },
        { id: "C3", is_member: true },
      ],
      response_metadata: { next_cursor: "" },
    });
    emptyHistory();
    const res = await sync(cursor({ phase: "list", ids: [] }));
    expect(cursorOf(res)).toMatchObject({ phase: "history", ids: ["C3", "D1", "G1"], nextIdx: 1 });
    expect(res.hasMore).toBe(true);
  });

  test("an entry with no usable id marks the list partial, and the flag survives to the next page", async () => {
    fetchStub.respond("POST", LIST_URL, {
      ok: true,
      channels: [{ id: "C1", is_member: true }, { is_member: true }, "junk"],
      response_metadata: { next_cursor: "page-2" },
    });
    const res = await sync(cursor({ phase: "list", ids: [] }));
    expect(cursorOf(res)).toMatchObject({ phase: "list", ids: ["C1"], listPartial: true });
  });
});

describe("slack-sync - the read-marker pass at the end of a round", () => {
  test("the last channel's call runs auth.test and one conversations.info per channel, stores the markers once and returns to the list phase", async () => {
    emptyHistory();
    const routes = markerRoutes({
      C1: { last_read: "1700000100.000200" },
      D2: { is_im: true, last_read: "1700000300.000100" },
    });
    const res = await sync(
      cursor({ phase: "history", ids: ["C1", "D2"], nextIdx: 1, hw: { C1: "1700000050.000000" } }),
    );
    expect(fetchStub.calls.map((c) => c.url)).toEqual([HISTORY_URL, AUTH_URL, INFO_URL, INFO_URL]);
    expect(routes.infoChannels).toEqual(["C1", "D2"]);
    expect(listChatReadMarkers(db, "slack")).toEqual([
      expect.objectContaining({ channelId: "C1", channelKind: "public_channel" }),
      expect.objectContaining({
        channelId: "D2",
        channelKind: "im",
        lastReadTs: "1700000300.000100",
      }),
    ]);
    expect(res.hasMore).toBe(false);
    expect(cursorOf(res)).toMatchObject({
      phase: "list",
      ids: [],
      nextIdx: 0,
      listCursor: null,
      histCursor: null,
      selfUserId: "U9",
      mkIdx: 0,
      listPartial: false,
      floorTs: FLOOR_TS,
      teamSubdomain: "acme",
      hw: { C1: "1700000050.000000", D2: null },
    });
  });

  test("a call that does not end the round makes no marker request", async () => {
    emptyHistory();
    await sync(cursor({ phase: "history", ids: ["C1", "D2"], nextIdx: 0 }));
    expect(fetchStub.calls.map((c) => c.url)).toEqual([HISTORY_URL]);
    expect(listChatReadMarkers(db, "slack")).toEqual([]);
  });

  test("the next call after a round re-lists the conversations", async () => {
    emptyHistory();
    markerRoutes({ C1: { last_read: "1700000100.000200" } });
    const ended = await sync(cursor({ phase: "history", ids: ["C1"], nextIdx: 0 }));
    fetchStub.calls.length = 0;
    fetchStub.respond("POST", LIST_URL, {
      ok: true,
      channels: [
        { id: "C1", is_member: true },
        { id: "C7", is_member: true },
      ],
      response_metadata: { next_cursor: "" },
    });
    const next = await sync(ended.cursor as string);
    expect(fetchStub.calls[0]?.url).toBe(LIST_URL);
    expect(cursorOf(next)).toMatchObject({ phase: "history", ids: ["C1", "C7"] });
  });

  test("an empty list result returns to the list phase instead of idling on an empty history", async () => {
    fetchStub.respond("POST", LIST_URL, {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await sync(cursor({ phase: "list", ids: [] }));
    expect(cursorOf(res)).toMatchObject({ phase: "list", ids: [] });
    expect(res.hasMore).toBe(false);
  });

  test("a cursor stuck in an empty history by an older version is healed", async () => {
    const res = await sync(cursor({ phase: "history", ids: [], legacy: true }));
    expect(cursorOf(res)).toMatchObject({ phase: "list", ids: [] });
  });

  test("a conversations.info failure never fails the sync; the items are still indexed", async () => {
    fetchStub.respond("POST", HISTORY_URL, {
      ok: true,
      messages: [{ ts: "1700000100.000200", text: "hello", user: "U1" }],
      response_metadata: {},
    });
    markerRoutes({ C1: "internal_error" });
    const res = await sync(cursor({ phase: "history", ids: ["C1"], nextIdx: 0 }));
    expect(res.itemsUpserted).toBe(1);
    expect(slackRows()).toHaveLength(1);
    expect(listChatReadMarkers(db, "slack")).toEqual([]);
    expect(cursorOf(res)).toMatchObject({ phase: "list", selfUserId: "U9" });
  });

  test("a fetch that rejects for every marker call is swallowed too", async () => {
    emptyHistory();
    const res = await sync(cursor({ phase: "history", ids: ["C1"], nextIdx: 0 }));
    expect(res.hasMore).toBe(false);
    expect(cursorOf(res)).toMatchObject({ phase: "list", selfUserId: null });
  });

  test("a complete list prunes the markers of channels the owner left; an incomplete one never does", async () => {
    setChatReadMarkerRows(
      db,
      "slack",
      [{ channelId: "GONE", channelKind: "public_channel", lastReadTs: "1700000000.000001" }],
      undefined,
      1,
    );
    emptyHistory();
    markerRoutes({ C1: { last_read: "1700000100.000200" } });
    await sync(
      encodeNimbusJsonCursor(CURSOR_PREFIX, {
        phase: "history",
        floorTs: FLOOR_TS,
        ids: ["C1"],
        nextIdx: 0,
        hw: {},
        listCursor: null,
        histCursor: null,
        teamSubdomain: "acme",
        selfUserId: null,
        mkIdx: 0,
        listPartial: true,
      }),
    );
    expect(listChatReadMarkers(db, "slack").map((m) => m.channelId)).toEqual(["C1", "GONE"]);

    emptyHistory();
    await sync(cursor({ phase: "history", ids: ["C1"], nextIdx: 0 }));
    expect(listChatReadMarkers(db, "slack").map((m) => m.channelId)).toEqual(["C1"]);
  });

  test("a rate-limited marker pass keeps the markers it did not reach and retries that channel first", async () => {
    setChatReadMarkerRows(
      db,
      "slack",
      [{ channelId: "C3", channelKind: "public_channel", lastReadTs: "1700000000.000009" }],
      undefined,
      1,
    );
    emptyHistory();
    markerRoutes({
      C1: { last_read: "1700000100.000200" },
      C2: "ratelimited",
      C3: { last_read: "1700000500.000000" },
    });
    const res = await sync(cursor({ phase: "history", ids: ["C1", "C2", "C3"], nextIdx: 2 }));
    const stored = Object.fromEntries(
      listChatReadMarkers(db, "slack").map((m) => [m.channelId, m.lastReadTs]),
    );
    expect(stored).toEqual({ C1: "1700000100.000200", C3: "1700000000.000009" });
    expect(cursorOf(res)).toMatchObject({ mkIdx: 1 });
  });

  test("a cursor from before MB4 (no selfUserId, mkIdx or listPartial) still decodes and runs", async () => {
    emptyHistory();
    markerRoutes({ C1: { last_read: "1700000100.000200" } });
    const res = await sync(cursor({ phase: "history", ids: ["C1"], nextIdx: 0, legacy: true }));
    expect(cursorOf(res)).toMatchObject({ phase: "list", selfUserId: "U9", mkIdx: 0 });
  });
});
