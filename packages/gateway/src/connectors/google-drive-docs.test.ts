/**
 * Google Docs are indexed as `google_drive:doc` with their plain-text export, and existing Docs are
 * rewritten by a one-time re-list carried on the `delta` cursor (spec § 8, role packs P2 PR 3).
 *
 * The rows are written through the real sync capabilities (`upsertIndexedItemForSync`, the depth
 * chokepoint) over a migrated in-memory index, and the Drive API is a URL-matched stub, so no
 * `mock.module` is needed.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import type { SyncContext } from "../sync/types.ts";
import { UnauthenticatedError } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import {
  createGoogleDriveSyncable,
  DOC_EXPORTS_PER_SYNC,
  DOCS_RELIST_PAGES_PER_SYNC,
  type DriveSyncCursorV1,
  decodeDriveSyncCursor,
  encodeDriveSyncCursor,
} from "./google-drive-sync.ts";

const CHANGES_LIST_RE = /^https:\/\/www\.googleapis\.com\/drive\/v3\/changes\?/;
const EXPORT_RE = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)\/export\?/;
/** The re-list's listing — the only `files` listing whose `q` names the Doc mime type. */
const RELIST_RE =
  /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\?.*q=mimeType\+%3D\+%27application%2Fvnd\.google-apps\.document%27/;

const DOC_MIME = "application/vnd.google-apps.document";
const ENSURE = { ensureGoogleDriveRunning: async (): Promise<void> => {} };
const RELIST_DONE = { doneAt: "full" } as const;
const BOM = String.fromCodePoint(0xfe_ff);

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

function ctx(depth: "metadata_only" | "summary" | "full" = "full"): SyncContext {
  return {
    ...syncTestContext(db, EMPTY_NIMBUS_VAULT, "google_drive", depth),
    accessToken: () => Promise.resolve("drive-token"),
    // The budget tests issue 100+ requests; the real token bucket would make them wait.
    rateLimiter: new ProviderRateLimiter({
      google: { requestsPerMinute: 1_000_000, burstSize: 100_000 },
    }),
  };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function docFile(id: string, modifiedTime: string = isoDaysAgo(1)) {
  return { id, name: `Doc ${id}`, mimeType: DOC_MIME, modifiedTime };
}

type Row = {
  id: string;
  type: string;
  body: string | null;
  body_complete: number;
  bodyFetch: string | null;
  count: number;
};

function row(externalId: string): Row | null {
  return db
    .query<Row, [string]>(
      `SELECT id, type, body, body_complete, json_extract(metadata, '$.bodyFetch') AS bodyFetch,
              (SELECT COUNT(*) FROM item WHERE external_id = i.external_id) AS count
         FROM item i WHERE service = 'google_drive' AND external_id = ?`,
    )
    .get(externalId);
}

function exportCalls(): string[] {
  return fetchStub.calls.flatMap((c) => {
    const m = EXPORT_RE.exec(c.url);
    return m === null ? [] : [decodeURIComponent(m[1] ?? "")];
  });
}

function relistCalls(): number {
  return fetchStub.calls.filter((c) => RELIST_RE.test(c.url)).length;
}

/** A `file` row exactly as the pre-PR-3 Drive sync wrote it for a Doc. */
function seedLegacyFileRow(id: string, modifiedAt: number): void {
  upsertIndexedItem(db, {
    service: "google_drive",
    type: "file",
    externalId: id,
    title: `Doc ${id}`,
    bodyPreview: `Doc ${id}`,
    modifiedAt,
    metadata: { mimeType: DOC_MIME },
    syncedAt: modifiedAt,
  });
}

function changesPage(files: object[], newStartPageToken = "start-next"): void {
  fetchStub.respond("GET", CHANGES_LIST_RE, {
    newStartPageToken,
    changes: files.map((file) => ({ fileId: (file as { id: string }).id, file })),
  });
}

type DeltaDocs = Extract<DriveSyncCursorV1, { phase: "delta" }>["docs"];

async function syncDelta(docs: DeltaDocs, c: SyncContext = ctx()) {
  const cursor = encodeDriveSyncCursor({
    v: 1,
    phase: "delta",
    pageToken: "delta-1",
    ...(docs === undefined ? {} : { docs }),
  });
  const res = await createGoogleDriveSyncable(ENSURE).sync(c, cursor);
  return { res, cursor: decodeDriveSyncCursor(res.cursor ?? "") };
}

describe("Drive Docs — a changed Doc", () => {
  test("is exported and re-types its old `file` row in place, under the same id", async () => {
    seedLegacyFileRow("d1", 1);
    changesPage([docFile("d1")]);
    fetchStub.respondWithText("GET", EXPORT_RE, `${BOM}We decided to ship weekly.`);

    const { res } = await syncDelta(RELIST_DONE);

    expect(res.itemsUpserted).toBe(1);
    expect(exportCalls()).toEqual(["d1"]);
    expect(row("d1")).toEqual({
      id: "google_drive:d1",
      type: "doc",
      body: "We decided to ship weekly.",
      body_complete: 1,
      bodyFetch: "complete",
      count: 1,
    });
  });

  test("whose stored text is this revision's is not exported again", async () => {
    const modifiedTime = isoDaysAgo(2);
    changesPage([docFile("d1", modifiedTime)]);
    fetchStub.respondWithText("GET", EXPORT_RE, "first text");
    await syncDelta(RELIST_DONE);
    expect(exportCalls()).toEqual(["d1"]);

    const { res } = await syncDelta(RELIST_DONE);
    expect(exportCalls()).toEqual(["d1"]);
    expect(res.itemsUpserted).toBe(0);
    expect(row("d1")?.body).toBe("first text");
  });

  test("is exported again when a metadata_only reindex removed its body", async () => {
    const modifiedTime = isoDaysAgo(2);
    changesPage([docFile("d1", modifiedTime)]);
    fetchStub.respondWithText("GET", EXPORT_RE, "text");
    await syncDelta(RELIST_DONE);
    db.run("UPDATE item SET body = NULL, body_preview = NULL, body_complete = 0 WHERE id = ?", [
      "google_drive:d1",
    ]);

    await syncDelta(RELIST_DONE);
    expect(exportCalls()).toEqual(["d1", "d1"]);
    expect(row("d1")?.body).toBe("text");
  });

  test("over the prose cap is stored capped and never reported complete", async () => {
    changesPage([docFile("d1")]);
    fetchStub.respondWithText("GET", EXPORT_RE, "x".repeat(20_000));
    await syncDelta(RELIST_DONE);
    const r = row("d1");
    expect(r?.body?.length).toBe(16_384);
    expect(r?.body_complete).toBe(0);
    expect(r?.bodyFetch).toBe("capped");
  });

  test("other files are untouched: still `file`, metadata only, no export", async () => {
    changesPage([
      { id: "p1", name: "spec.pdf", mimeType: "application/pdf", size: "2048" },
      { id: "i1", name: "shot.png", mimeType: "image/png", size: "10" },
    ]);
    await syncDelta(RELIST_DONE);
    expect(exportCalls()).toEqual([]);
    const meta = db
      .query<{ external_id: string; type: string; metadata: string }, []>(
        "SELECT external_id, type, metadata FROM item WHERE service = 'google_drive' ORDER BY external_id",
      )
      .all();
    expect(meta).toEqual([
      {
        external_id: "i1",
        type: "file",
        metadata: JSON.stringify({ mimeType: "image/png", size: "10" }),
      },
      {
        external_id: "p1",
        type: "file",
        metadata: JSON.stringify({ mimeType: "application/pdf", size: "2048" }),
      },
    ]);
  });
});

describe("Drive Docs — depth", () => {
  test("metadata_only exports nothing and stores no text", async () => {
    changesPage([docFile("d1")]);
    await syncDelta({ doneAt: "metadata_only" }, ctx("metadata_only"));
    expect(exportCalls()).toEqual([]);
    expect(row("d1")?.type).toBe("doc");
    expect(row("d1")?.body).toBe("");
    expect(row("d1")?.bodyFetch).toBeNull();
  });

  test("summary exports but records no verdict, so a later deepen exports again", async () => {
    changesPage([docFile("d1")]);
    fetchStub.respondWithText("GET", EXPORT_RE, "summary text");
    await syncDelta({ doneAt: "summary" }, ctx("summary"));
    expect(exportCalls()).toEqual(["d1"]);
    expect(row("d1")?.bodyFetch).toBeNull();
  });
});

describe("Drive Docs — export failures", () => {
  test("a 403 indexes the Doc without text and the sync succeeds", async () => {
    changesPage([docFile("d1"), docFile("d2")]);
    fetchStub.respond(
      "GET",
      /\/files\/d1\/export\?/,
      { error: { message: "This file is too large to be exported." } },
      { status: 403 },
    );
    fetchStub.respondWithText("GET", EXPORT_RE, "d2 text");

    const { res, cursor } = await syncDelta(RELIST_DONE);

    expect(res.itemsUpserted).toBe(2);
    expect(row("d1")).toMatchObject({ type: "doc", body: "Doc d1", bodyFetch: null });
    expect(row("d2")?.body).toBe("d2 text");
    // Permanent: no re-list for it.
    expect(cursor).toMatchObject({ docs: RELIST_DONE });
    expect(relistCalls()).toBe(0);
  });

  test("a 429 indexes the Doc without text, and the re-armed re-list gives it its text", async () => {
    changesPage([docFile("d1")]);
    fetchStub.respond("GET", RELIST_RE, { files: [docFile("d1")] });
    fetchStub.respondWithText("GET", EXPORT_RE, "d1 text on retry");
    // The FIRST export (the changes page's) is rate-limited; the re-list's retry succeeds.
    const routed = globalThis.fetch;
    let exports = 0;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (EXPORT_RE.test(url) && exports++ === 0) {
        return Promise.resolve(
          Response.json({ error: { message: "Rate Limit Exceeded" } }, { status: 429 }),
        );
      }
      return routed(input, init);
    }) as typeof fetch;

    const { res, cursor } = await syncDelta(RELIST_DONE);

    expect(exports).toBe(2);
    expect(relistCalls()).toBe(1);
    expect(row("d1")).toMatchObject({ body: "d1 text on retry", bodyFetch: "complete" });
    expect(cursor).toMatchObject({ docs: RELIST_DONE });
    expect(res.hasMore).toBe(false);
  });

  test("a 401 fails the sync as unauthenticated", async () => {
    changesPage([docFile("d1")]);
    fetchStub.respond("GET", EXPORT_RE, {}, { status: 401 });
    await expect(syncDelta(RELIST_DONE)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe("Drive Docs — the one-time re-list", () => {
  test("an upgraded cursor re-lists: an indexed Doc gets text, an old unindexed one stays out", async () => {
    seedLegacyFileRow("old-indexed", Date.parse(isoDaysAgo(400)));
    changesPage([]);
    fetchStub.respond("GET", RELIST_RE, {
      files: [
        docFile("old-indexed", isoDaysAgo(400)),
        docFile("old-unindexed", isoDaysAgo(400)),
        docFile("recent", isoDaysAgo(3)),
      ],
    });
    fetchStub.respondWithText("GET", EXPORT_RE, "body");

    const { res, cursor } = await syncDelta(undefined);

    expect(relistCalls()).toBe(1);
    expect(exportCalls().sort()).toEqual(["old-indexed", "recent"]);
    expect(row("old-indexed")?.type).toBe("doc");
    expect(row("old-unindexed")).toBeNull();
    expect(row("recent")?.type).toBe("doc");
    expect(res.itemsUpserted).toBe(2);
    expect(cursor).toEqual({ v: 1, phase: "delta", pageToken: "start-next", docs: RELIST_DONE });
    expect(res.hasMore).toBe(false);
    // The query never lists trashed Docs.
    const q = new URL(
      fetchStub.calls.find((c) => RELIST_RE.test(c.url))?.url ?? "",
    ).searchParams.get("q");
    expect(q).toBe(`mimeType = '${DOC_MIME}' and trashed = false`);
  });

  test("resumes from its list token, while each call still applies the changes page first", async () => {
    changesPage([]);
    fetchStub.respond("GET", RELIST_RE, { files: [docFile("a")] });
    fetchStub.respondWithText("GET", EXPORT_RE, "t");

    const { res, cursor } = await syncDelta({ listToken: "relist-page-2" });

    expect(fetchStub.calls[0]?.url).toMatch(CHANGES_LIST_RE);
    const relistUrl = new URL(fetchStub.calls.find((c) => RELIST_RE.test(c.url))?.url ?? "");
    expect(relistUrl.searchParams.get("pageToken")).toBe("relist-page-2");
    expect(cursor?.phase === "delta" ? cursor.docs : undefined).toEqual(RELIST_DONE);
    expect(res.hasMore).toBe(false);
  });

  test("lists at most DOCS_RELIST_PAGES_PER_SYNC pages per call, even when they cost no export", async () => {
    changesPage([]);
    // Every listing answers "more to come": only the per-call page bound can stop this call.
    fetchStub.respond("GET", RELIST_RE, { files: [], nextPageToken: "p-next" });

    const { res, cursor } = await syncDelta({ listToken: null });

    expect(relistCalls()).toBe(DOCS_RELIST_PAGES_PER_SYNC);
    expect(res.hasMore).toBe(true);
    expect(cursor?.phase === "delta" ? cursor.docs : undefined).toEqual({ listToken: "p-next" });
  });

  test("does not start a page when the changes page left fewer than 100 exports", async () => {
    const many = Array.from({ length: DOC_EXPORTS_PER_SYNC - 99 }, (_, i) =>
      docFile(`c${String(i)}`),
    );
    changesPage(many);
    fetchStub.respondWithText("GET", EXPORT_RE, "t");

    const { res, cursor } = await syncDelta({ listToken: "keep-me" });

    expect(relistCalls()).toBe(0);
    expect(cursor?.phase === "delta" ? cursor.docs : undefined).toEqual({ listToken: "keep-me" });
    expect(res.hasMore).toBe(true);
  });

  test("a depth change re-arms a finished re-list", async () => {
    changesPage([]);
    fetchStub.respond("GET", RELIST_RE, { files: [] });
    const { cursor } = await syncDelta({ doneAt: "summary" });
    expect(relistCalls()).toBe(1);
    expect(cursor?.phase === "delta" ? cursor.docs : undefined).toEqual(RELIST_DONE);
  });

  test("a finished re-list at the run's depth makes no listing call", async () => {
    changesPage([]);
    await syncDelta(RELIST_DONE);
    expect(relistCalls()).toBe(0);
  });

  test("an unreadable docs value decodes as not started", () => {
    const raw = encodeDriveSyncCursor({
      v: 1,
      phase: "delta",
      pageToken: "t",
      docs: { doneAt: "deep" } as unknown as { doneAt: "full" },
    });
    expect(decodeDriveSyncCursor(raw)).toEqual({ v: 1, phase: "delta", pageToken: "t" });
  });
});
