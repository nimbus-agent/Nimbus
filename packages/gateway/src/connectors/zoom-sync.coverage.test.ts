/**
 * Zoom paths the main suite does not reach: an access token that resolves to "", list pages with
 * no `next_page_token` key (the walk must stop, not request a page literally named "undefined"),
 * a `meetings` field that is not an array, and a recordings meeting with no numeric id whose
 * transcript must still be indexed even though the meeting itself cannot be.
 *
 * The token comes through the context's own `accessToken` capability, so no OAuth blob is parsed.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { decodeNimbusJsonCursorObject } from "./nimbus-json-cursor.ts";
import { createZoomSyncable } from "./zoom-sync.ts";

const MEETINGS_RE = /^https:\/\/api\.zoom\.us\/v2\/users\/me\/meetings\?/;
const RECORDINGS_RE = /^https:\/\/api\.zoom\.us\/v2\/users\/me\/recordings\?/;
const DOWNLOAD_URL = "https://zoom.example.test/rec/download/tx-9.vtt";
const VTT = ["WEBVTT", "", "1", "00:00:01.000 --> 00:00:02.000", "<v Ana>Ship it."].join("\n");

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

function ctx(token = "zoom-token"): SyncContext {
  return {
    ...syncTestContext(db, createStubVault({ "zoom.oauth": "stored-oauth-blob" }), "zoom"),
    accessToken: () => Promise.resolve(token),
  };
}

function sync(c: SyncContext, cursor: string | null = null) {
  return createZoomSyncable({ ensureZoomMcpRunning: async () => {} }).sync(c, cursor);
}

function callsMatching(re: RegExp): number {
  return fetchStub.calls.filter((c) => re.test(c.url)).length;
}

function zoomRows(): { type: string; external_id: string }[] {
  return db
    .query("SELECT type, external_id FROM item WHERE service = 'zoom' ORDER BY external_id")
    .all() as { type: string; external_id: string }[];
}

describe("zoom-sync — empty access token", () => {
  test("a token that resolves to the empty string is a no-op: no request, cursor kept", async () => {
    const res = await sync(ctx(""), "prev-zoom-cursor");

    expect(res.cursor).toBe("prev-zoom-cursor");
    expect(res.itemsUpserted).toBe(0);
    expect(fetchStub.calls).toHaveLength(0);
  });
});

describe("zoom-sync — Walk A (scheduled meetings) page shapes", () => {
  test("a page with meetings but no `next_page_token` key ends the walk after that page", async () => {
    fetchStub.respond("GET", MEETINGS_RE, {
      meetings: [{ id: 101, topic: "Planning", start_time: "2026-06-01T10:00:00Z" }],
    });
    fetchStub.respond("GET", RECORDINGS_RE, { meetings: [], next_page_token: "" });

    const res = await sync(ctx());

    expect(callsMatching(MEETINGS_RE)).toBe(1);
    expect(res.itemsUpserted).toBe(1);
    expect(zoomRows()).toEqual([{ type: "meeting", external_id: "101" }]);
  });

  test("a `meetings` field that is not an array indexes nothing", async () => {
    fetchStub.respond("GET", MEETINGS_RE, {
      meetings: { "101": { id: 101 } },
      next_page_token: "p2",
    });
    fetchStub.respond("GET", RECORDINGS_RE, { meetings: [], next_page_token: "" });

    const res = await sync(ctx());

    expect(callsMatching(MEETINGS_RE)).toBe(1);
    expect(res.itemsUpserted).toBe(0);
    expect(zoomRows()).toEqual([]);
  });
});

describe("zoom-sync — Walk B (recordings) edge cases", () => {
  test("an id-less recorded meeting still gets its transcript indexed; junk file entries are skipped", async () => {
    fetchStub.respond("GET", MEETINGS_RE, { meetings: [], next_page_token: "" });
    // No `next_page_token` key on the recordings page either: the walk must stop after it.
    fetchStub.respond("GET", RECORDINGS_RE, {
      meetings: [
        {
          uuid: "uuid-adhoc",
          topic: "Ad-hoc sync",
          recording_files: [
            null,
            "not-a-file",
            {
              id: "tx-9",
              file_type: "TRANSCRIPT",
              download_url: DOWNLOAD_URL,
              recording_start: "2026-06-01T10:05:00Z",
            },
          ],
        },
      ],
    });
    fetchStub.respondWithText("GET", DOWNLOAD_URL, VTT);

    const before = Date.now();
    const res = await sync(ctx());
    const after = Date.now();

    expect(callsMatching(RECORDINGS_RE)).toBe(1);
    expect(res.itemsUpserted).toBe(1);
    expect(zoomRows()).toEqual([{ type: "transcript", external_id: "uuid-adhoc:tx-9" }]);
    const body = db
      .query("SELECT body FROM item WHERE service = 'zoom' AND type = 'transcript'")
      .get() as { body: string };
    expect(body.body).toBe("Ship it.");
    // The walk completed, so the recordings window advanced to its `to` bound — the sync's own
    // "now", not the window's `from` (30 days earlier).
    const cursor = decodeNimbusJsonCursorObject(res.cursor, "nimbus-zoom1:");
    const advancedTo = Date.parse(String(cursor?.["lastRecordingsTo"]));
    expect(advancedTo).toBeGreaterThanOrEqual(before);
    expect(advancedTo).toBeLessThanOrEqual(after);
  });
});
