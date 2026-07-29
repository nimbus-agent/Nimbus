import { afterEach, describe, expect, test } from "bun:test";
import { itemPrimaryKey } from "../index/item-store.ts";
import { UnauthenticatedError } from "../sync/types.ts";
import {
  createOAuthConnectorTestSetup,
  expectPrefixedCursorCodecRoundTrip,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../testing/bun-test-support.ts";
import {
  createGoogleMeetSyncable,
  decodeGoogleMeetSyncCursor,
  encodeGoogleMeetSyncCursor,
  type GoogleMeetSyncCursorV1,
} from "./google-meet-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

describe("Google Meet sync cursor codec", () => {
  test("round-trip", () => {
    const samples: GoogleMeetSyncCursorV1[] = [
      { v: 1, pageToken: null },
      { v: 1, pageToken: "next" },
    ];
    expectPrefixedCursorCodecRoundTrip(
      samples,
      encodeGoogleMeetSyncCursor,
      decodeGoogleMeetSyncCursor,
      "nimbus-gmeet1:",
    );
  });

  // L35 branch: o == null (wrong prefix → decodeNimbusJsonCursorPayload returns undefined)
  test("decodeGoogleMeetSyncCursor returns undefined for wrong prefix", () => {
    expect(decodeGoogleMeetSyncCursor("nimbus-OTHER:abc")).toBeUndefined();
  });

  // L35 branch: typeof o !== "object" (payload decodes to a primitive, e.g. a JSON number)
  test("decodeGoogleMeetSyncCursor returns undefined when payload is a primitive", () => {
    const raw = encodeNimbusJsonCursor("nimbus-gmeet1:", 42);
    expect(decodeGoogleMeetSyncCursor(raw)).toBeUndefined();
  });

  // L35 branch: Array.isArray(o) (payload decodes to an array)
  test("decodeGoogleMeetSyncCursor returns undefined when payload is an array", () => {
    const raw = encodeNimbusJsonCursor("nimbus-gmeet1:", [1, 2, 3]);
    expect(decodeGoogleMeetSyncCursor(raw)).toBeUndefined();
  });

  // L39 branch: r["v"] !== 1 (object but wrong version)
  test("decodeGoogleMeetSyncCursor returns undefined when v field is not 1", () => {
    const raw = encodeNimbusJsonCursor("nimbus-gmeet1:", { v: 2, pageToken: null });
    expect(decodeGoogleMeetSyncCursor(raw)).toBeUndefined();
  });

  // L43 branch: pageToken is not null and not a string (e.g. a number)
  test("decodeGoogleMeetSyncCursor returns undefined when pageToken is not null/string", () => {
    const raw = encodeNimbusJsonCursor("nimbus-gmeet1:", { v: 1, pageToken: 99 });
    expect(decodeGoogleMeetSyncCursor(raw)).toBeUndefined();
  });
});

/** Route a fake fetch: participants requests first, then the records list. */
function meetFetch(handlers: {
  records: (url: string) => Response;
  participants?: (url: string) => Response;
}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = requestUrlString(input);
    if (url.includes("/participants")) {
      if (handlers.participants === undefined) {
        throw new Error(`unexpected participants fetch: ${url}`);
      }
      return handlers.participants(url);
    }
    if (url.includes("conferenceRecords")) {
      return handlers.records(url);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function emptyParticipants(): Response {
  return new Response(JSON.stringify({ participants: [], totalSize: 0 }), { status: 200 });
}

describe("createGoogleMeetSyncable", () => {
  registerGlobalFetchRestore(afterEach);

  test("indexes conference records and paginates via nextPageToken", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = meetFetch({
      records: (url) => {
        expect(url).toContain("pageSize=50");
        return new Response(
          JSON.stringify({
            conferenceRecords: [
              {
                name: "conferenceRecords/c1",
                startTime: "2024-01-02T09:00:00Z",
                endTime: "2024-01-02T10:00:00Z",
                space: "spaces/s1",
              },
            ],
            nextPageToken: "n1",
          }),
          { status: 200 },
        );
      },
      participants: emptyParticipants,
    });

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.hasMore).toBe(true);
    expect(r.cursor).not.toBeNull();

    const row = db
      .query("SELECT id, service, external_id, type, title FROM item WHERE id = ?")
      .get(itemPrimaryKey("google_meet", "c1")) as
      | { id: string; service: string; external_id: string; type: string; title: string }
      | undefined;
    expect(row?.service).toBe("google_meet");
    expect(row?.external_id).toBe("c1");
    expect(row?.type).toBe("meeting");
    expect(row?.title).toBe("Meeting 2024-01-02");
  });

  test("second pass forwards the page token and stops when nextPageToken is absent", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = meetFetch({
      records: (url) => {
        expect(url).toContain("pageToken=n1");
        return new Response(
          JSON.stringify({
            conferenceRecords: [
              { name: "conferenceRecords/c2", startTime: "2024-02-03T00:00:00Z" },
            ],
          }),
          { status: 200 },
        );
      },
      participants: emptyParticipants,
    });

    const cursor = encodeGoogleMeetSyncCursor({ v: 1, pageToken: "n1" });
    const r = await syncable.sync(ctx, cursor);
    expect(r.itemsUpserted).toBe(1);
    expect(r.hasMore).toBe(false);
    expect(r.cursor).toBeNull();
  });

  // L85 branch: dec is undefined → dec?.pageToken is undefined → ?? null arm taken
  // This happens when the cursor has the right prefix but an invalid payload
  test("corrupt cursor (valid prefix, invalid payload) falls back to pageToken=null", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });
    let capturedUrl = "";

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      capturedUrl = url;
      return new Response(JSON.stringify({ conferenceRecords: [], nextPageToken: "" }), {
        status: 200,
      });
    }) as typeof fetch;

    // Encode a payload with the right prefix but v !== 1, so decodeGoogleMeetSyncCursor returns undefined
    const badCursor = encodeNimbusJsonCursor("nimbus-gmeet1:", { v: 99, pageToken: "ignored" });
    const r = await syncable.sync(ctx, badCursor);
    // dec is undefined → pageToken falls back to null → no pageToken param in URL
    expect(capturedUrl).not.toContain("pageToken=");
    expect(r.hasMore).toBe(false);
    expect(r.itemsUpserted).toBe(0);
  });

  // L90 branch: parsed.conferenceRecords is undefined → ?? [] arm taken (empty list)
  test("response with no conferenceRecords key yields 0 upserts", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("conferenceRecords")) {
        // Omit the conferenceRecords key entirely
        return new Response(JSON.stringify({ nextPageToken: "" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.hasMore).toBe(false);
    expect(r.cursor).toBeNull();
  });

  // L95 branch: mapped === null → continue (record with no name is skipped)
  test("conference record without a name is skipped (mapped === null)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("conferenceRecords")) {
        return new Response(
          JSON.stringify({
            conferenceRecords: [
              // Record without `name` → mapGoogleMeetRecordToItem returns null
              { startTime: "2024-03-01T10:00:00Z", endTime: "2024-03-01T11:00:00Z" },
              // Valid record that should be upserted
              {
                name: "conferenceRecords/c99",
                startTime: "2024-03-01T10:00:00Z",
                endTime: "2024-03-01T11:00:00Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/participants")) {
        return emptyParticipants();
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    // The nameless record is skipped, only c99 is upserted
    expect(r.itemsUpserted).toBe(1);
  });

  test("a nameless record costs no participants request", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });
    const participantUrls: string[] = [];

    globalThis.fetch = meetFetch({
      records: () =>
        new Response(
          JSON.stringify({
            conferenceRecords: [{ startTime: "2024-03-01T10:00:00Z" }],
          }),
          { status: 200 },
        ),
      participants: (url) => {
        participantUrls.push(url);
        return emptyParticipants();
      },
    });

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expect(participantUrls).toEqual([]);
  });

  test("401 throws UnauthenticatedError with API message", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), {
        status: 401,
      })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await syncable.sync(ctx, null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnauthenticatedError);
    expect((caught as Error).message).toMatch(/Invalid Credentials/);
  });
});

// ---------------------------------------------------------------------------
// Participant detail (issue #893)
// ---------------------------------------------------------------------------

function oneRecord(): Response {
  return new Response(
    JSON.stringify({
      conferenceRecords: [
        {
          name: "conferenceRecords/c1",
          startTime: "2024-01-02T09:00:00Z",
          endTime: "2024-01-02T10:00:00Z",
          space: "spaces/s1",
        },
      ],
    }),
    { status: 200 },
  );
}

function meetingRow(db: {
  query: (sql: string) => { get: (id: string) => unknown };
}): { title: string; body_preview: string | null; metadata: string } | undefined {
  return db
    .query("SELECT title, body_preview, metadata FROM item WHERE id = ?")
    .get(itemPrimaryKey("google_meet", "c1")) as
    | { title: string; body_preview: string | null; metadata: string }
    | undefined;
}

describe("createGoogleMeetSyncable — participants", () => {
  registerGlobalFetchRestore(afterEach);

  test("fetches the roster per record and stores it on the meeting item", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });
    const participantUrls: string[] = [];

    globalThis.fetch = meetFetch({
      records: oneRecord,
      participants: (url) => {
        participantUrls.push(url);
        return new Response(
          JSON.stringify({
            participants: [
              {
                name: "conferenceRecords/c1/participants/p1",
                earliestStartTime: "2024-01-02T09:01:00Z",
                latestEndTime: "2024-01-02T09:59:00Z",
                signedinUser: { user: "users/1", displayName: "Ada Lovelace" },
              },
              { anonymousUser: { displayName: "Guest" } },
            ],
            totalSize: 2,
          }),
          { status: 200 },
        );
      },
    });

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);

    expect(participantUrls).toHaveLength(1);
    expect(participantUrls[0]).toContain(
      "https://meet.googleapis.com/v2/conferenceRecords/c1/participants",
    );
    expect(participantUrls[0]).toContain("pageSize=100");

    const row = meetingRow(db);
    expect(row?.title).toBe("Meeting with Ada Lovelace, Guest — 2024-01-02");
    expect(row?.body_preview).toBe("Ada Lovelace, Guest");
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["participants"]).toEqual([
      { kind: "signed_in", id: "users/1", displayName: "Ada Lovelace" },
      { kind: "anonymous", id: null, displayName: "Guest" },
    ]);
    expect(meta["participantCount"]).toBe(2);
  });

  test("join/leave times never reach the indexed row", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = meetFetch({
      records: oneRecord,
      participants: () =>
        new Response(
          JSON.stringify({
            participants: [
              {
                name: "conferenceRecords/c1/participants/p1",
                earliestStartTime: "2024-01-02T09:01:00Z",
                latestEndTime: "2024-01-02T09:59:00Z",
                signedinUser: { user: "users/1", displayName: "Ada Lovelace" },
              },
            ],
            totalSize: 1,
          }),
          { status: 200 },
        ),
    });

    await syncable.sync(ctx, null);
    const meta = meetingRow(db)?.metadata ?? "";
    expect(meta).toContain("Ada Lovelace");
    expect(meta).not.toContain("2024-01-02T09:01:00Z");
    expect(meta).not.toContain("2024-01-02T09:59:00Z");
    expect(meta).not.toContain("participants/p1");
  });

  test("totalSize larger than the stored roster drives the `+N` remainder", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = meetFetch({
      records: oneRecord,
      participants: () =>
        new Response(
          JSON.stringify({
            participants: ["Ada", "Grace", "Alan"].map((n, i) => ({
              signedinUser: { user: `users/${String(i)}`, displayName: n },
            })),
            totalSize: 40,
          }),
          { status: 200 },
        ),
    });

    await syncable.sync(ctx, null);
    const row = meetingRow(db);
    expect(row?.title).toBe("Meeting with Ada, Grace, Alan +37 — 2024-01-02");
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["participantCount"]).toBe(40);
  });

  test("a nonsense totalSize falls back to the stored roster length", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = meetFetch({
      records: oneRecord,
      participants: () =>
        new Response(
          JSON.stringify({
            participants: [{ signedinUser: { user: "users/1", displayName: "Ada" } }],
            // Smaller than the returned list, and the wrong type in a second run.
            totalSize: 0,
          }),
          { status: 200 },
        ),
    });

    await syncable.sync(ctx, null);
    const meta = JSON.parse(meetingRow(db)?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["participantCount"]).toBe(1);
  });

  test("a missing participants key yields an empty roster and the v1 title", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = meetFetch({
      records: oneRecord,
      participants: () => new Response(JSON.stringify({}), { status: 200 }),
    });

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = meetingRow(db);
    expect(row?.title).toBe("Meeting 2024-01-02");
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["participants"]).toEqual([]);
    expect(meta["participantCount"]).toBe(0);
  });

  test("a 403 on participants still indexes the conference record", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = meetFetch({
      records: oneRecord,
      participants: () =>
        new Response(JSON.stringify({ error: { message: "Insufficient Permission" } }), {
          status: 403,
        }),
    });

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = meetingRow(db);
    expect(row?.title).toBe("Meeting 2024-01-02");
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["participants"]).toEqual([]);
  });

  test("a 401 on participants still surfaces UnauthenticatedError", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = meetFetch({
      records: oneRecord,
      participants: () =>
        new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), {
          status: 401,
        }),
    });

    let caught: unknown;
    try {
      await syncable.sync(ctx, null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnauthenticatedError);
  });

  test("invalid participants JSON degrades to an empty roster", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = meetFetch({
      records: oneRecord,
      participants: () => new Response("{not json", { status: 200 }),
    });

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const meta = JSON.parse(meetingRow(db)?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["participants"]).toEqual([]);
  });

  test("the stored roster is clipped at 100 names", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = meetFetch({
      records: oneRecord,
      participants: () =>
        new Response(
          JSON.stringify({
            participants: Array.from({ length: 150 }, (_, i) => ({
              signedinUser: { user: `users/${String(i)}`, displayName: `P${String(i)}` },
            })),
            totalSize: 150,
          }),
          { status: 200 },
        ),
    });

    await syncable.sync(ctx, null);
    const meta = JSON.parse(meetingRow(db)?.metadata ?? "{}") as {
      participants: unknown[];
      participantCount: number;
    };
    expect(meta.participants).toHaveLength(100);
    expect(meta.participantCount).toBe(150);
  });
});
