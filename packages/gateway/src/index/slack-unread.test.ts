/**
 * The Slack unread reader against rows the REAL Slack sync wrote: nothing here hand-inserts an `item`
 * row for a Slack message, so `external_id`, `metadata.channel/user/thread_ts` and `type` are exactly
 * what production writes (the "queries filter on keys no connector writes" lesson).
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { encodeSlackCursor } from "../connectors/slack-cursor.ts";
import { createSlackSyncable } from "../connectors/slack-sync.ts";
import { setSchedulerCursor, upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import {
  type ChatReadMarkerInput,
  type ChatReadMarkerKind,
  setChatReadMarkerRows,
} from "./chat-read-marker-store.ts";
import {
  chatKindOf,
  countUnreadSlackThreads,
  loadSlackSelfUserId,
  slackTsToMs,
} from "./slack-unread.ts";

const HISTORY_URL = "https://slack.com/api/conversations.history";

type Msg = { ts: string; user?: string; text?: string; thread_ts?: string; subtype?: string };

let db: Database;
let stub: StubFetch;

beforeEach(() => {
  db = createMemoryIndexDb();
  stub = new StubFetch();
});
afterEach(() => {
  stub.restore();
  db.close();
});

/** Indexes `messages` of `channel` by running the real Slack syncable's history step (no round end). */
async function indexMessages(channel: string, messages: Msg[]): Promise<void> {
  stub.restore();
  stub = new StubFetch();
  stub.install();
  stub.respond("POST", HISTORY_URL, { ok: true, messages, response_metadata: {} });
  const ctx = {
    ...syncTestContext(db, createStubVault({ "slack.oauth": "blob" }), "slack"),
    accessToken: () => Promise.resolve("xoxp-test"),
  };
  const cursor = encodeSlackCursor({
    phase: "history",
    floorTs: "1700000000.000000",
    ids: [channel, "ZZZZ"],
    nextIdx: 0,
    hw: {},
    listCursor: null,
    histCursor: null,
    teamSubdomain: "acme",
    selfUserId: null,
    mkIdx: 0,
    listPartial: false,
  });
  await createSlackSyncable({ ensureSlackMcpRunning: async () => {} }).sync(ctx, cursor);
  stub.restore();
}

function marker(
  channelId: string,
  lastReadTs: string,
  channelKind: ChatReadMarkerKind = "public_channel",
  at = 1000,
): void {
  const m: ChatReadMarkerInput = { channelId, channelKind, lastReadTs };
  setChatReadMarkerRows(db, "slack", [m], undefined, at);
}

describe("countUnreadSlackThreads", () => {
  test("a message newer than last_read counts; at or before it does not (equal is read)", async () => {
    await indexMessages("C1", [
      { ts: "1700000100.000100", user: "U2", text: "before" },
      { ts: "1700000200.000000", user: "U2", text: "equal" },
      { ts: "1700000300.000000", user: "U2", text: "after" },
    ]);
    marker("C1", "1700000200.000000");
    const out = countUnreadSlackThreads(db, { selfUserId: "UME" });
    expect(out.totalThreads).toBe(1);
    expect(out.threads).toEqual([
      {
        itemId: expect.any(String),
        channelId: "C1",
        channelName: null,
        channelKind: "channel",
        threadKey: "1700000300.000000",
        latestTsMs: 1700000300000,
        title: "after",
        url: "https://acme.slack.com/archives/C1/p1700000300000000",
        unreadMessages: 1,
      },
    ]);
  });

  test("the owner's own messages never count; a message with no user does", async () => {
    await indexMessages("C1", [
      { ts: "1700000300.000000", user: "UME", text: "mine" },
      { ts: "1700000400.000000", text: "from an app" },
    ]);
    marker("C1", "0000000000.000000");
    const out = countUnreadSlackThreads(db, { selfUserId: "UME" });
    expect(out.threads.map((t) => t.title)).toEqual(["from an app"]);
  });

  test("thread dedup: a parent and its broadcasts are ONE thread; unrelated top-level messages are two", async () => {
    await indexMessages("C1", [
      { ts: "1700000300.000000", user: "U2", text: "parent", thread_ts: "1700000300.000000" },
      {
        ts: "1700000400.000000",
        user: "U3",
        text: "bcast 1",
        thread_ts: "1700000300.000000",
        subtype: "thread_broadcast",
      },
      {
        ts: "1700000500.000000",
        user: "U3",
        text: "bcast 2",
        thread_ts: "1700000300.000000",
        subtype: "thread_broadcast",
      },
      { ts: "1700000600.000000", user: "U2", text: "other one" },
      { ts: "1700000700.000000", user: "U2", text: "other two" },
    ]);
    marker("C1", "0000000000.000000");
    const out = countUnreadSlackThreads(db, { selfUserId: "UME" });
    expect(out.totalThreads).toBe(3);
    const grouped = out.threads.find((t) => t.threadKey === "1700000300.000000");
    expect(grouped).toMatchObject({
      unreadMessages: 3,
      title: "bcast 2",
      latestTsMs: 1700000500000,
    });
  });

  test("a channel with no marker counts nothing and is listed once, sorted", async () => {
    await indexMessages("C9", [
      { ts: "1700000300.000000", user: "U2", text: "a" },
      { ts: "1700000400.000000", user: "U2", text: "b" },
    ]);
    await indexMessages("C2", [{ ts: "1700000300.000000", user: "U2", text: "c" }]);
    const out = countUnreadSlackThreads(db, { selfUserId: "UME" });
    expect(out.totalThreads).toBe(0);
    expect(out.channelsWithoutMarker).toEqual(["C2", "C9"]);
    expect(out.channelsWithMarker).toBe(0);
    expect(out.oldestMarkerCapturedAtMs).toBeNull();
    expect(out.newestMarkerCapturedAtMs).toBeNull();
  });

  test("a marker for a channel with no indexed message yields nothing", () => {
    marker("C5", "1700000000.000000");
    const out = countUnreadSlackThreads(db, { selfUserId: "UME" });
    expect(out).toMatchObject({ totalThreads: 0, threads: [], channelsWithMarker: 1 });
  });

  test("DMs and group DMs sort first, then newest first; limit caps the list but not the total", async () => {
    await indexMessages("C1", [{ ts: "1700000900.000000", user: "U2", text: "channel newest" }]);
    await indexMessages("D1", [{ ts: "1700000100.000000", user: "U2", text: "dm oldest" }]);
    await indexMessages("G1", [{ ts: "1700000200.000000", user: "U2", text: "mpim" }]);
    await indexMessages("C2", [{ ts: "1700000500.000000", user: "U2", text: "channel older" }]);
    marker("C1", "0000000000.000000", "public_channel");
    marker("D1", "0000000000.000000", "im");
    marker("G1", "0000000000.000000", "mpim");
    marker("C2", "0000000000.000000", "private_channel");
    const all = countUnreadSlackThreads(db, { selfUserId: "UME" });
    expect(all.threads.map((t) => [t.title, t.channelKind])).toEqual([
      ["mpim", "mpim"],
      ["dm oldest", "dm"],
      ["channel newest", "channel"],
      ["channel older", "channel"],
    ]);
    const capped = countUnreadSlackThreads(db, { selfUserId: "UME", limit: 2 });
    expect(capped.threads.map((t) => t.title)).toEqual(["mpim", "dm oldest"]);
    expect(capped.totalThreads).toBe(4);
    const none = countUnreadSlackThreads(db, { selfUserId: "UME", limit: 0 });
    expect(none).toMatchObject({ threads: [], totalThreads: 4 });
    const odd = countUnreadSlackThreads(db, { selfUserId: "UME", limit: Number.NaN });
    expect(odd).toMatchObject({ threads: [], totalThreads: 4 });
    expect(countUnreadSlackThreads(db, { selfUserId: "UME", limit: -3 }).threads).toEqual([]);
    expect(countUnreadSlackThreads(db, { selfUserId: "UME", limit: 1.9 }).threads).toHaveLength(1);
  });

  test("marker statistics: count, oldest and newest captured_at", () => {
    marker("C1", "1700000000.000000", "public_channel", 500);
    marker("C2", "1700000000.000000", "im", 900);
    expect(countUnreadSlackThreads(db, { selfUserId: "UME" })).toMatchObject({
      channelsWithMarker: 2,
      oldestMarkerCapturedAtMs: 500,
      newestMarkerCapturedAtMs: 900,
    });
  });

  test("an unknown own user id counts nothing but still reports the marker statistics", async () => {
    await indexMessages("C1", [{ ts: "1700000300.000000", user: "U2", text: "x" }]);
    marker("C1", "0000000000.000000");
    const out = countUnreadSlackThreads(db, { selfUserId: null });
    expect(out).toMatchObject({ totalThreads: 0, threads: [], channelsWithMarker: 1 });
  });

  test("a row with malformed metadata neither raises nor counts", async () => {
    await indexMessages("C1", [{ ts: "1700000300.000000", user: "U2", text: "good" }]);
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
       VALUES ('bad', 'slack', 'message', 'C1:1700000400.000000', 'bad', 1, 1, '{not json')`,
    );
    marker("C1", "0000000000.000000");
    const out = countUnreadSlackThreads(db, { selfUserId: "UME" });
    expect(out.threads.map((t) => t.title)).toEqual(["good"]);
  });

  test("a message whose ts is not Slack's fixed width is never compared", async () => {
    await indexMessages("C1", [{ ts: "1700000300.000000", user: "U2", text: "good" }]);
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
       VALUES ('odd', 'slack', 'message', 'C1:9999', 'odd', 1, 1, '{"channel":"C1","user":"U2","thread_ts":null}')`,
    );
    marker("C1", "0000000000.000000");
    expect(countUnreadSlackThreads(db, { selfUserId: "UME" }).threads.map((t) => t.title)).toEqual([
      "good",
    ]);
  });

  test("string compare is exact at the microsecond: 000099 is not newer than 000100", async () => {
    await indexMessages("C1", [
      { ts: "1700000000.000099", user: "U2", text: "older" },
      { ts: "1700000000.000101", user: "U2", text: "newer" },
    ]);
    marker("C1", "1700000000.000100");
    expect(countUnreadSlackThreads(db, { selfUserId: "UME" }).threads.map((t) => t.title)).toEqual([
      "newer",
    ]);
  });

  test("another service's messages never count, even with the same channel id", async () => {
    await indexMessages("C1", [{ ts: "1700000300.000000", user: "U2", text: "slack" }]);
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
       VALUES ('t1', 'teams', 'message', 'C1:1700000400.000000', 'teams', 1, 1, '{"channel":"C1","user":"U2"}')`,
    );
    marker("C1", "0000000000.000000");
    expect(countUnreadSlackThreads(db, { selfUserId: "UME" }).threads.map((t) => t.title)).toEqual([
      "slack",
    ]);
  });

  test("the default limit is 50 threads", async () => {
    const msgs: Msg[] = Array.from({ length: 55 }, (_, i) => ({
      ts: `17000${String(10000 + i)}.000000`,
      user: "U2",
      text: `m${String(i)}`,
    }));
    await indexMessages("C1", msgs);
    marker("C1", "0000000000.000000");
    const out = countUnreadSlackThreads(db, { selfUserId: "UME" });
    expect(out.threads).toHaveLength(50);
    expect(out.totalThreads).toBe(55);
  });
});

describe("chatKindOf and slackTsToMs", () => {
  test("every marker kind maps to one briefing kind", () => {
    expect(chatKindOf("im")).toBe("dm");
    expect(chatKindOf("mpim")).toBe("mpim");
    expect(chatKindOf("public_channel")).toBe("channel");
    expect(chatKindOf("private_channel")).toBe("channel");
  });

  test("ts converts without a floating-point cast", () => {
    expect(slackTsToMs("1700000300.000000")).toBe(1700000300000);
    expect(slackTsToMs("1700000300.123456")).toBe(1700000300123);
    expect(slackTsToMs("0000000000.000999")).toBe(0);
  });
});

describe("loadSlackSelfUserId", () => {
  const cursorWith = (selfUserId: string | null): string =>
    encodeSlackCursor({
      phase: "list",
      floorTs: "1700000000.000000",
      ids: [],
      nextIdx: 0,
      hw: {},
      listCursor: null,
      histCursor: null,
      teamSubdomain: null,
      selfUserId,
      mkIdx: 0,
      listPartial: false,
    });

  test("null with no scheduler row, no cursor or a cursor without the id", () => {
    expect(loadSlackSelfUserId(db)).toBeNull();
    upsertSchedulerRegistration(db, "slack", 300_000, 1, false);
    expect(loadSlackSelfUserId(db)).toBeNull();
    setSchedulerCursor(db, "slack", cursorWith(null));
    expect(loadSlackSelfUserId(db)).toBeNull();
    setSchedulerCursor(db, "slack", "nimbus-slk1:!!!");
    expect(loadSlackSelfUserId(db)).toBeNull();
  });

  test("reads the id the marker pass cached in the slack cursor", () => {
    upsertSchedulerRegistration(db, "slack", 300_000, 1, false);
    setSchedulerCursor(db, "slack", cursorWith("U123"));
    expect(loadSlackSelfUserId(db)).toBe("U123");
  });
});
