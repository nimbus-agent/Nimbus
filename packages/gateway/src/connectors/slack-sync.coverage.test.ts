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
}): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, {
    phase: fields.phase,
    floorTs: FLOOR_TS,
    ids: fields.ids,
    nextIdx: fields.nextIdx ?? 0,
    hw: {},
    listCursor: fields.listCursor ?? null,
    histCursor: null,
    teamSubdomain: "acme",
  });
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

    const res = await sync(cursor({ phase: "list", ids: ["C0"], listCursor: "page-2" }));

    expect(fetchStub.calls.map((c) => c.url)).toEqual([LIST_URL, HISTORY_URL]);
    expect(res.itemsUpserted).toBe(1);
    expect(res.hasMore).toBe(false);
    // Only the channel carried in from the earlier page was walked — never the lone object's C9.
    expect(slackRows().map((r) => r.external_id)).toEqual(["C0:1700000100.000200"]);
    expect(decodeNimbusJsonCursorObject(res.cursor, CURSOR_PREFIX)).toMatchObject({
      phase: "history",
      ids: ["C0"],
      nextIdx: 1,
      listCursor: null,
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
