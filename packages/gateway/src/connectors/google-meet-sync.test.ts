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
});

describe("createGoogleMeetSyncable", () => {
  registerGlobalFetchRestore(afterEach);

  test("indexes conference records and paginates via nextPageToken", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google");
    const syncable = createGoogleMeetSyncable({ ensureGoogleMcpRunning: async () => {} });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("conferenceRecords")) {
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
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

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

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      expect(url).toContain("pageToken=n1");
      return new Response(
        JSON.stringify({
          conferenceRecords: [{ name: "conferenceRecords/c2", startTime: "2024-02-03T00:00:00Z" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const cursor = encodeGoogleMeetSyncCursor({ v: 1, pageToken: "n1" });
    const r = await syncable.sync(ctx, cursor);
    expect(r.itemsUpserted).toBe(1);
    expect(r.hasMore).toBe(false);
    expect(r.cursor).toBeNull();
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
