/**
 * Google Drive response shapes the main suite never sends: a changes page with no `changes` key,
 * an initial file listing with no `files` key, and a change whose file carries an id but no name.
 *
 * The access token is supplied through the context's own `accessToken` capability (the seam the
 * syncable reads it from), so this file needs no `mock.module`.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import {
  createGoogleDriveSyncable,
  decodeDriveSyncCursor,
  encodeDriveSyncCursor,
} from "./google-drive-sync.ts";

const START_TOKEN_RE = /^https:\/\/www\.googleapis\.com\/drive\/v3\/changes\/startPageToken\?/;
const FILES_LIST_RE = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\?/;
const CHANGES_LIST_RE = /^https:\/\/www\.googleapis\.com\/drive\/v3\/changes\?/;

const ENSURE = { ensureGoogleDriveRunning: async (): Promise<void> => {} };

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
    ...syncTestContext(db, EMPTY_NIMBUS_VAULT, "google_drive"),
    accessToken: () => Promise.resolve("drive-token"),
  };
}

function driveRows(): { external_id: string; title: string }[] {
  return db
    .query(
      "SELECT external_id, title FROM item WHERE service = 'google_drive' ORDER BY external_id",
    )
    .all() as { external_id: string; title: string }[];
}

describe("google-drive-sync — absent response arrays", () => {
  test("a delta page with no `changes` key applies nothing and rolls over to the new start token", async () => {
    fetchStub.respond("GET", CHANGES_LIST_RE, { newStartPageToken: "start-after-empty" });

    const res = await createGoogleDriveSyncable(ENSURE).sync(
      ctx(),
      encodeDriveSyncCursor({ v: 1, phase: "delta", pageToken: "delta-7" }),
    );

    expect(res.itemsUpserted).toBe(0);
    expect(res.itemsDeleted).toBe(0);
    expect(res.hasMore).toBe(false);
    expect(decodeDriveSyncCursor(res.cursor ?? "")).toEqual({
      v: 1,
      phase: "delta",
      pageToken: "start-after-empty",
    });
    expect(fetchStub.calls).toHaveLength(1);
    expect(new URL(fetchStub.calls[0]?.url ?? "").searchParams.get("pageToken")).toBe("delta-7");
    expect(driveRows()).toEqual([]);
  });

  test("an initial listing with no `files` key indexes nothing and moves on to the drain phase", async () => {
    fetchStub.respond("GET", START_TOKEN_RE, { startPageToken: "t0-empty-list" });
    fetchStub.respond("GET", FILES_LIST_RE, {});

    const res = await createGoogleDriveSyncable(ENSURE).sync(ctx(), null);

    expect(res.itemsUpserted).toBe(0);
    expect(res.hasMore).toBe(true);
    expect(decodeDriveSyncCursor(res.cursor ?? "")).toEqual({
      v: 1,
      phase: "drain",
      changePage: "t0-empty-list",
    });
    expect(driveRows()).toEqual([]);
  });
});

describe("google-drive-sync — a changed file without a name", () => {
  test("is never written, while a named file in the same page still is", async () => {
    fetchStub.respond("GET", CHANGES_LIST_RE, {
      newStartPageToken: "start-2",
      changes: [
        { fileId: "nameless", file: { id: "nameless", mimeType: "text/plain" } },
        {
          fileId: "named",
          file: {
            id: "named",
            name: "Roadmap",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-01-02T03:04:05.000Z",
          },
        },
      ],
    });

    const res = await createGoogleDriveSyncable(ENSURE).sync(
      ctx(),
      encodeDriveSyncCursor({ v: 1, phase: "delta", pageToken: "delta-1" }),
    );

    expect(res.hasMore).toBe(false);
    expect(driveRows()).toEqual([{ external_id: "named", title: "Roadmap" }]);
  });
});
