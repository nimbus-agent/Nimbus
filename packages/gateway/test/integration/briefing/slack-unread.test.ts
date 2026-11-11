/**
 * Morning briefing MB4, end to end over real SQLite: the REAL Slack syncable (through the production
 * capability set `syncTestContext` binds, and through the real `SyncScheduler` for the egress cases),
 * a fake Slack HTTP layer, the V92 `chat_read_marker` table, and the reader the briefing will call.
 * Nothing here hand-inserts a Slack `item` row: the reader is shown to agree with the WRITER.
 *
 * The index is a real SQLite FILE in a fresh temp directory; everything runs in this process (the
 * syncables run inside the gateway, so no subprocess would add anything).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { createSlackSyncable } from "../../../src/connectors/slack-sync.ts";
import {
  listChatReadMarkers,
  setChatReadMarkerRows,
} from "../../../src/index/chat-read-marker-store.ts";
import { readUnreadChatThreads } from "../../../src/index/chat-unread-query.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { countUnreadSlackThreads, loadSlackSelfUserId } from "../../../src/index/slack-unread.ts";
import { ensureFullSqlite } from "../../../src/platform/sqlite-runtime.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { SyncScheduler } from "../../../src/sync/scheduler.ts";
import {
  setSchedulerCursor,
  upsertSchedulerRegistration,
} from "../../../src/sync/scheduler-store.ts";
import type { SyncContext, SyncRuntimeContext } from "../../../src/sync/types.ts";
import { createMemoryVault, requestUrlString } from "../../../src/testing/bun-test-support.ts";
import { rmDirWithRetry } from "../../helpers/rm-dir-with-retry.ts";

const tempDirs: string[] = [];
let db: Database;

function createFileIndexDb(): Database {
  ensureFullSqlite();
  const root = mkdtempSync(join(tmpdir(), "nimbus-slack-unread-"));
  tempDirs.push(root);
  const d = new Database(join(root, "index.db"));
  LocalIndex.ensureSchema(d);
  return d;
}

type Channel = Record<string, unknown> & { id: string };
type Msg = { ts: string; user?: string; text: string; thread_ts?: string; subtype?: string };

const world: {
  channels: Channel[];
  messages: Record<string, Msg[]>;
  /** A conversations.info `channel` object, or a Slack error code. */
  info: Record<string, Record<string, unknown> | string>;
  calls: string[];
} = { channels: [], messages: {}, info: {}, calls: [] };

const realFetch = globalThis.fetch;

function slackFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = requestUrlString(input);
  const method = url.slice("https://slack.com/api/".length);
  world.calls.push(method);
  const body = JSON.parse(String(init?.body ?? "{}")) as { channel?: string };
  const json = (v: unknown): Promise<Response> => Promise.resolve(Response.json(v));
  switch (method) {
    case "auth.test":
      return json({ ok: true, user_id: "UME", url: "https://acme.slack.com/" });
    case "conversations.list":
      return json({ ok: true, channels: world.channels, response_metadata: { next_cursor: "" } });
    case "conversations.history":
      return json({
        ok: true,
        messages: world.messages[body.channel ?? ""] ?? [],
        response_metadata: { next_cursor: "" },
      });
    case "conversations.info": {
      const id = body.channel ?? "";
      const reply = world.info[id];
      if (reply === undefined) return json({ ok: false, error: "channel_not_found" });
      return typeof reply === "string"
        ? json({ ok: false, error: reply })
        : json({ ok: true, channel: { id, ...reply } });
    }
    default:
      return Promise.resolve(new Response("{}", { status: 404 }));
  }
}

beforeEach(() => {
  db = createFileIndexDb();
  world.channels = [];
  world.messages = {};
  world.info = {};
  world.calls = [];
  globalThis.fetch = slackFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
  for (const d of tempDirs.splice(0)) rmDirWithRetry(d);
});

const GENEROUS = { slack: { requestsPerMinute: 60_000, burstSize: 100 } };
const syncable = () => createSlackSyncable({ ensureSlackMcpRunning: async () => {} });

function directCtx(): SyncContext {
  return {
    ...syncTestContext(db, createStubVault({ "slack.oauth": "blob" }), "slack"),
    accessToken: () => Promise.resolve("xoxp-test"),
    rateLimiter: new ProviderRateLimiter(GENEROUS),
  };
}

/** Runs sync() until the run says it is done (one history round), threading the cursor. */
async function runRound(ctx: SyncContext, from: string | null = null): Promise<string> {
  let cursor = from;
  for (let i = 0; i < 20; i++) {
    const res = await syncable().sync(ctx, cursor);
    cursor = res.cursor;
    if (!res.hasMore) return cursor ?? "";
  }
  throw new Error("the round did not finish");
}

function storeCursor(cursor: string): void {
  upsertSchedulerRegistration(db, "slack", 300_000, Date.now(), false);
  setSchedulerCursor(db, "slack", cursor);
}

function threeConversations(): void {
  world.channels = [
    { id: "C1", is_member: true },
    { id: "D1", is_im: true },
    { id: "G1", is_mpim: true },
    { id: "C9", is_member: false },
  ];
  world.messages = {
    C1: [
      { ts: "1700000100.000000", user: "U2", text: "old channel message" },
      { ts: "1700000200.000000", user: "U2", text: "new channel message" },
    ],
    D1: [
      { ts: "1700000300.000000", user: "U2", text: "dm for me" },
      { ts: "1700000310.000000", user: "UME", text: "my own reply" },
    ],
    G1: [{ ts: "1700000250.000000", user: "U3", text: "group dm" }],
  };
  world.info = {
    C1: { is_channel: true, last_read: "1700000150.000000" },
    D1: { is_im: true, last_read: "1700000000.000001" },
    G1: { is_mpim: true, last_read: "0000000000.000000" },
  };
}

describe("Slack read markers, end to end", () => {
  test("a round stores a marker per indexed conversation and the reader lists DMs and group DMs first", async () => {
    threeConversations();
    const cursor = await runRound(directCtx());
    storeCursor(cursor);

    expect(listChatReadMarkers(db, "slack").map((m) => [m.channelId, m.channelKind])).toEqual([
      ["C1", "public_channel"],
      ["D1", "im"],
      ["G1", "mpim"],
    ]);
    expect(loadSlackSelfUserId(db)).toBe("UME");

    const out = countUnreadSlackThreads(db, { selfUserId: loadSlackSelfUserId(db) });
    expect(out.threads.map((t) => [t.channelId, t.channelKind, t.title])).toEqual([
      ["D1", "dm", "dm for me"],
      ["G1", "mpim", "group dm"],
      ["C1", "channel", "new channel message"],
    ]);
    expect(out).toMatchObject({
      totalThreads: 3,
      channelsWithMarker: 3,
      channelsWithoutMarker: [],
    });

    // The briefing's seam returns the same thing without being told who the owner is.
    const seam = readUnreadChatThreads(db, { nowMs: Date.now(), limit: 2 });
    expect(seam.totalThreads).toBe(3);
    expect(seam.threads.map((t) => t.channelId)).toEqual(["D1", "G1"]);
    expect(seam.threads[0]).toMatchObject({
      url: "https://acme.slack.com/archives/D1/p1700000300000000",
      latestTsMs: 1700000300000,
    });
  });

  test("a second round re-lists, so a conversation joined later is indexed and one left loses its marker", async () => {
    threeConversations();
    const first = await runRound(directCtx());
    expect(listChatReadMarkers(db, "slack").map((m) => m.channelId)).toEqual(["C1", "D1", "G1"]);

    world.channels = [
      { id: "C1", is_member: true },
      { id: "D1", is_im: true },
      { id: "C5", is_member: true },
    ];
    world.messages["C5"] = [{ ts: "1700000400.000000", user: "U2", text: "new channel" }];
    world.info["C5"] = { is_channel: true, last_read: "0000000000.000000" };
    world.calls = [];
    await runRound(directCtx(), first);

    expect(world.calls[0]).toBe("conversations.list");
    expect(listChatReadMarkers(db, "slack").map((m) => m.channelId)).toEqual(["C1", "C5", "D1"]);
    expect(
      (
        db.query("SELECT count(*) AS n FROM item WHERE external_id LIKE 'C5:%'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  test("running the Slack sync never changes another service's items or markers", async () => {
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
       VALUES ('t1', 'teams', 'message', 'C1:1700000900.000000', 'teams msg', 1, 1, '{"channel":"C1"}')`,
    );
    db.run(
      `INSERT INTO chat_read_marker (service, channel_id, channel_kind, last_read_ts, captured_at)
       VALUES ('other', 'C1', 'im', '1700000000.000001', 5)`,
    );
    threeConversations();
    await runRound(directCtx());
    expect(db.query("SELECT title FROM item WHERE service = 'teams'").all()).toEqual([
      { title: "teams msg" },
    ]);
    expect(listChatReadMarkers(db, "other")).toEqual([
      { channelId: "C1", channelKind: "im", lastReadTs: "1700000000.000001", capturedAt: 5 },
    ]);
    // ...and the teams row is never read as a Slack unread.
    expect(
      countUnreadSlackThreads(db, { selfUserId: "UME" }).threads.every(
        (t) => t.title !== "teams msg",
      ),
    ).toBe(true);
  });

  test("a partial pass (rate limited at the third conversation) keeps the markers it did not reach", async () => {
    threeConversations();
    setChatReadMarkerRows(
      db,
      "slack",
      [{ channelId: "G1", channelKind: "mpim", lastReadTs: "1700000100.000000" }],
      undefined,
      7,
    );
    world.info["G1"] = "ratelimited";
    const cursor = await runRound(directCtx());
    const byId = Object.fromEntries(listChatReadMarkers(db, "slack").map((m) => [m.channelId, m]));
    expect(byId["C1"]?.lastReadTs).toBe("1700000150.000000");
    expect(byId["D1"]?.lastReadTs).toBe("1700000000.000001");
    expect(byId["G1"]).toMatchObject({ lastReadTs: "1700000100.000000", capturedAt: 7 });
    // The unreached channel is retried first on the next pass.
    expect(
      JSON.parse(Buffer.from(cursor.slice("nimbus-slk1:".length), "base64url").toString()),
    ).toMatchObject({
      mkIdx: 2,
    });
  });

  test("removing the connector's index data clears the markers", async () => {
    threeConversations();
    await runRound(directCtx());
    expect(listChatReadMarkers(db, "slack")).toHaveLength(3);
    new LocalIndex(db).removeConnectorIndexData("slack");
    expect(listChatReadMarkers(db, "slack")).toEqual([]);
  });
});

describe("Slack read markers and the egress ledger", () => {
  // The scheduler keeps prepared statements for its lifetime, which a Windows file database cannot
  // close under; these cases need no file reopen, so they run on an in-memory index.
  beforeEach(() => {
    db.close();
    db = createMemoryIndexDb();
  });

  function runtime(vault: ReturnType<typeof createMemoryVault>): SyncRuntimeContext {
    return {
      ...(directCtx() as SyncContext),
      db,
      vault,
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter(GENEROUS),
      credentialFor: () => ({ credential: "personal" }),
      runTeamList: async () => [],
    } as unknown as SyncRuntimeContext;
  }

  async function configuredVault(): Promise<ReturnType<typeof createMemoryVault>> {
    const vault = createMemoryVault();
    await vault.set(
      "slack.oauth",
      JSON.stringify({
        accessToken: "xoxp-test",
        refreshToken: "r",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      }),
    );
    return vault;
  }

  test("one forced run appends exactly one sync row however many conversations.info calls it made", async () => {
    threeConversations();
    // A cursor at the last channel of a round: this single sync() call ends it, marker pass included.
    const cursor = Buffer.from(
      JSON.stringify({
        phase: "history",
        floorTs: "1700000000.000000",
        ids: ["C1", "D1", "G1"],
        nextIdx: 2,
        hw: {},
        listCursor: null,
        histCursor: null,
        teamSubdomain: "acme",
        selfUserId: null,
        mkIdx: 0,
        listPartial: false,
      }),
    ).toString("base64url");
    const rows: Array<{ destination: string; sourceType: string; method: string }> = [];
    const sched = new SyncScheduler(runtime(await configuredVault()), undefined, {
      appendSyncEgress: (r) => rows.push(r),
    });
    sched.register(syncable());
    setSchedulerCursor(db, "slack", `nimbus-slk1:${cursor}`);
    await sched.forceSync("slack");
    await sched.stop();

    expect(world.calls.filter((c) => c === "conversations.info")).toHaveLength(3);
    expect(rows).toEqual([{ destination: "slack", sourceType: "sync", method: "sync.run" }]);
    expect(listChatReadMarkers(db, "slack")).toHaveLength(3);
    expect(loadSlackSelfUserId(db)).toBe("UME");
  });

  test("an unconfigured run appends no row and makes no Slack request", async () => {
    threeConversations();
    const rows: unknown[] = [];
    const sched = new SyncScheduler(runtime(createMemoryVault()), undefined, {
      appendSyncEgress: (r) => rows.push(r),
    });
    sched.register(syncable());
    await sched.forceSync("slack");
    await sched.stop();
    expect(rows).toEqual([]);
    expect(world.calls).toEqual([]);
    expect(listChatReadMarkers(db, "slack")).toEqual([]);
  });
});
