import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { encodeSlackCursor } from "../connectors/slack-cursor.ts";
import { setSchedulerCursor, upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { setChatReadMarkerRows } from "./chat-read-marker-store.ts";
import { type ChatUnreadReader, readUnreadChatThreads } from "./chat-unread-query.ts";

let db: Database;
beforeEach(() => {
  db = createMemoryIndexDb();
});
afterEach(() => {
  db.close();
});

function seedSelf(selfUserId: string | null): void {
  upsertSchedulerRegistration(db, "slack", 300_000, 1, false);
  setSchedulerCursor(
    db,
    "slack",
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
    }),
  );
}

function seedMessage(id: string, channel: string, ts: string, user: string, title: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, synced_at, metadata)
     VALUES (?, 'slack', 'message', ?, ?, ?, 1, 1, ?)`,
    [
      id,
      `${channel}:${ts}`,
      title,
      `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}`,
      JSON.stringify({ channel, user, thread_ts: null }),
    ],
  );
}

describe("readUnreadChatThreads (the MB5 seam)", () => {
  test("matches the ChatUnreadReader signature", () => {
    const reader: ChatUnreadReader = readUnreadChatThreads;
    expect(typeof reader).toBe("function");
  });

  test("an unknown own user id gives no threads but still fills the marker counts", () => {
    setChatReadMarkerRows(
      db,
      "slack",
      [{ channelId: "C1", channelKind: "im", lastReadTs: "0000000000.000000" }],
      undefined,
      700,
    );
    seedMessage("m1", "C1", "1700000300.000000", "U2", "hello");
    expect(readUnreadChatThreads(db, { nowMs: 1, limit: 10 })).toMatchObject({
      totalThreads: 0,
      threads: [],
      channelsWithMarker: 1,
      oldestMarkerCapturedAtMs: 700,
      newestMarkerCapturedAtMs: 700,
    });
  });

  test("resolves the own user id itself and maps every field; DMs first; limit passes through", () => {
    seedSelf("UME");
    setChatReadMarkerRows(
      db,
      "slack",
      [
        { channelId: "C1", channelKind: "public_channel", lastReadTs: "0000000000.000000" },
        { channelId: "D1", channelKind: "im", lastReadTs: "1700000000.000000" },
      ],
      undefined,
      900,
    );
    seedMessage("m1", "C1", "1700000500.000000", "U2", "in a channel");
    seedMessage("m2", "D1", "1700000100.000000", "U2", "a dm");
    seedMessage("m3", "D1", "1700000200.000000", "UME", "my own reply");
    const out = readUnreadChatThreads(db, { nowMs: 123, limit: 10 });
    expect(out).toMatchObject({
      totalThreads: 2,
      channelsWithMarker: 2,
      oldestMarkerCapturedAtMs: 900,
      newestMarkerCapturedAtMs: 900,
    });
    expect(out.threads).toEqual([
      {
        itemId: "m2",
        channelId: "D1",
        channelName: null,
        channelKind: "dm",
        threadKey: "1700000100.000000",
        latestTsMs: 1700000100000,
        title: "a dm",
        url: "https://acme.slack.com/archives/D1/p1700000100000000",
        unreadMessages: 1,
      },
      {
        itemId: "m1",
        channelId: "C1",
        channelName: null,
        channelKind: "channel",
        threadKey: "1700000500.000000",
        latestTsMs: 1700000500000,
        title: "in a channel",
        url: "https://acme.slack.com/archives/C1/p1700000500000000",
        unreadMessages: 1,
      },
    ]);
    expect(readUnreadChatThreads(db, { nowMs: 123, limit: 1 })).toMatchObject({
      totalThreads: 2,
      threads: [{ itemId: "m2" }],
    });
  });

  test("an empty index is an empty result", () => {
    expect(readUnreadChatThreads(db, { nowMs: 1, limit: 5 })).toMatchObject({
      totalThreads: 0,
      threads: [],
      channelsWithMarker: 0,
      oldestMarkerCapturedAtMs: null,
      newestMarkerCapturedAtMs: null,
      channelsWithoutMarker: [],
    });
  });
});
