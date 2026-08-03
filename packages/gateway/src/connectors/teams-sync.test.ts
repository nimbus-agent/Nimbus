import { afterEach, describe, expect, test } from "bun:test";
import { itemPrimaryKey } from "../index/item-store.ts";
import {
  createOAuthConnectorTestSetup,
  expectPrefixedCursorCodecRoundTrip,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../testing/bun-test-support.ts";
import {
  createTeamsSyncable,
  decodeTeamsSyncCursor,
  encodeTeamsSyncCursor,
  type TeamsSyncCursorV1,
} from "./teams-sync.ts";

type FetchInput = string | URL | Request;

describe("Teams sync cursor codec", () => {
  test("round-trip", () => {
    const samples: TeamsSyncCursorV1[] = [
      {
        v: 1,
        phase: "teams",
        teams: [],
        teamsNext: null,
        channelTeamIdx: 0,
        channelsByTeam: {},
        chanNext: null,
        pairs: [],
        pairIdx: 0,
        deltaByKey: {},
      },
      {
        v: 1,
        phase: "messages",
        teams: [{ id: "t1" }],
        teamsNext: null,
        channelTeamIdx: 1,
        channelsByTeam: { t1: ["c1"] },
        chanNext: null,
        pairs: [{ teamId: "t1", channelId: "c1" }],
        pairIdx: 0,
        deltaByKey: { "t1|c1": "https://graph.microsoft.com/v1.0/delta?token=x" },
      },
    ];
    expectPrefixedCursorCodecRoundTrip(
      samples,
      encodeTeamsSyncCursor,
      (raw) => decodeTeamsSyncCursor(raw),
      "nimbus-tms1:",
    );
  });
});

describe("createTeamsSyncable", () => {
  registerGlobalFetchRestore(afterEach);

  test("indexes channel messages after teams and channels discovery", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createTeamsSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/joinedTeams")) {
        return new Response(JSON.stringify({ value: [{ id: "team-1", displayName: "T" }] }), {
          status: 200,
        });
      }
      if (url.includes("/teams/team-1/channels") && !url.includes("/messages")) {
        return new Response(
          JSON.stringify({ value: [{ id: "chan-1", membershipType: "standard" }] }),
          { status: 200 },
        );
      }
      if (url.includes("/messages/delta")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: "msg-1",
                createdDateTime: "2024-05-01T10:00:00Z",
                body: { contentType: "text", content: "Hello channel" },
                from: { user: { id: "ms-user-1", displayName: "Pat" } },
              },
            ],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/teams/x/channels/y/messages/delta?token=z",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r1 = await syncable.sync(ctx, null);
    expect(r1.hasMore).toBe(true);
    expect(r1.itemsUpserted).toBe(0);

    const r2 = await syncable.sync(ctx, r1.cursor);
    expect(r2.hasMore).toBe(true);
    expect(r2.itemsUpserted).toBe(0);

    const r3 = await syncable.sync(ctx, r2.cursor);
    expect(r3.itemsUpserted).toBe(0);
    expect(r3.hasMore).toBe(true);

    const r4 = await syncable.sync(ctx, r3.cursor);
    expect(r4.itemsUpserted).toBe(1);
    expect(r4.hasMore).toBe(false);

    const row = db
      .query("SELECT service, type, author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "team-1:chan-1:msg-1")) as
      | { service: string; type: string; author_id: string | null }
      | undefined;
    expect(row?.service).toBe("teams");
    expect(row?.type).toBe("message");
    expect(row?.author_id).not.toBeNull();
  });

  test("teams phase paginates via @odata.nextLink (lines 55-67)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createTeamsSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/joinedTeams")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "team-1", displayName: "T1" }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/joinedTeams?$skiptoken=abc",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r1 = await syncable.sync(ctx, null);
    expect(r1.hasMore).toBe(true);
    expect(r1.itemsUpserted).toBe(0);
    // Cursor must still be in the teams phase with teamsNext set so the next
    // pass resumes pagination rather than advancing to channels.
    expect(typeof r1.cursor).toBe("string");
    const decoded = decodeTeamsSyncCursor(r1.cursor as string);
    expect(decoded?.phase).toBe("teams");
    expect(decoded?.teamsNext).not.toBeNull();
    expect(decoded?.teams).toEqual([{ id: "team-1" }]);
  });

  test("channels phase paginates via @odata.nextLink (lines 124-136)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createTeamsSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/teams/team-1/channels") && !url.includes("/messages")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "chan-1", membershipType: "standard" }],
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/teams/team-1/channels?$skiptoken=z",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    // Drive directly into the channels phase with one team to discover.
    const channelsCursor = encodeTeamsSyncCursor({
      v: 1,
      phase: "channels",
      teams: [{ id: "team-1" }],
      teamsNext: null,
      channelTeamIdx: 0,
      channelsByTeam: {},
      chanNext: null,
      pairs: [],
      pairIdx: 0,
      deltaByKey: {},
    });

    const r = await syncable.sync(ctx, channelsCursor);
    expect(r.hasMore).toBe(true);
    expect(r.itemsUpserted).toBe(0);
    expect(typeof r.cursor).toBe("string");
    const decoded = decodeTeamsSyncCursor(r.cursor as string);
    // Still in channels phase, same team index, but chanNext now set for the
    // next pass to continue paginating this team's channels.
    expect(decoded?.phase).toBe("channels");
    expect(decoded?.channelTeamIdx).toBe(0);
    expect(decoded?.chanNext).not.toBeNull();
    expect(decoded?.channelsByTeam["team-1"]).toEqual(["chan-1"]);
  });

  test("messages phase with empty pairs returns immediately (lines 156-164)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createTeamsSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    // No fetch should ever happen on this path.
    globalThis.fetch = (async (input: FetchInput) => {
      throw new Error(`unexpected fetch: ${requestUrlString(input)}`);
    }) as unknown as typeof fetch;

    const emptyPairsCursor = encodeTeamsSyncCursor({
      v: 1,
      phase: "messages",
      teams: [{ id: "team-1" }],
      teamsNext: null,
      channelTeamIdx: 1,
      channelsByTeam: { "team-1": [] },
      chanNext: null,
      pairs: [],
      pairIdx: 0,
      deltaByKey: {},
    });

    const r = await syncable.sync(ctx, emptyPairsCursor);
    expect(r.hasMore).toBe(false);
    expect(r.itemsUpserted).toBe(0);
    expect(r.itemsDeleted).toBe(0);
    expect(typeof r.cursor).toBe("string");
    const decoded = decodeTeamsSyncCursor(r.cursor as string);
    expect(decoded?.phase).toBe("messages");
    expect(decoded?.pairs).toEqual([]);
  });

  test("messages phase past last pair returns immediately (lines 166-175)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createTeamsSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      throw new Error(`unexpected fetch: ${requestUrlString(input)}`);
    }) as unknown as typeof fetch;

    // pairIdx points past the only pair → pair === undefined branch.
    const exhaustedCursor = encodeTeamsSyncCursor({
      v: 1,
      phase: "messages",
      teams: [{ id: "team-1" }],
      teamsNext: null,
      channelTeamIdx: 1,
      channelsByTeam: { "team-1": ["chan-1"] },
      chanNext: null,
      pairs: [{ teamId: "team-1", channelId: "chan-1" }],
      pairIdx: 1,
      deltaByKey: {},
    });

    const r = await syncable.sync(ctx, exhaustedCursor);
    expect(r.hasMore).toBe(false);
    expect(r.itemsUpserted).toBe(0);
    expect(r.itemsDeleted).toBe(0);
  });

  test("messages phase deletes @removed messages (lines 200-206)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createTeamsSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    // Pass 1: index a normal message so there is a row to delete later.
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: "msg-del",
                createdDateTime: "2024-05-01T10:00:00Z",
                body: { contentType: "text", content: "soon to be removed" },
                from: { user: { id: "ms-user-1", displayName: "Pat" } },
              },
            ],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/teams/team-1/channels/chan-1/messages/delta?token=d1",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const messagesCursor = encodeTeamsSyncCursor({
      v: 1,
      phase: "messages",
      teams: [{ id: "team-1" }],
      teamsNext: null,
      channelTeamIdx: 1,
      channelsByTeam: { "team-1": ["chan-1"] },
      chanNext: null,
      pairs: [{ teamId: "team-1", channelId: "chan-1" }],
      pairIdx: 0,
      deltaByKey: {},
    });

    const r1 = await syncable.sync(ctx, messagesCursor);
    expect(r1.itemsUpserted).toBe(1);

    const beforeRow = db
      .query("SELECT id FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "team-1:chan-1:msg-del"));
    expect(beforeRow).toBeTruthy();

    // Pass 2: the delta now reports the message as removed → deletion branch.
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "msg-del", "@removed": { reason: "deleted" } }],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/teams/team-1/channels/chan-1/messages/delta?token=d2",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r2 = await syncable.sync(ctx, r1.cursor);
    expect(r2.itemsDeleted).toBe(1);
    expect(r2.itemsUpserted).toBe(0);

    const afterRow = db
      .query("SELECT id FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "team-1:chan-1:msg-del"));
    expect(afterRow).toBeFalsy();
  });

  test("a Teams message over the prose cap is not reported complete", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createTeamsSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    // 20 KiB of body content, well over BODY_MAX_PROSE (16384)
    const huge = "x".repeat(20_000);

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: "msg-huge",
                createdDateTime: "2024-05-01T10:00:00Z",
                body: { contentType: "text", content: huge },
                from: { user: { id: "ms-user-1", displayName: "Pat" } },
              },
            ],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/teams/team-1/channels/chan-1/messages/delta?token=d1",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const messagesCursor = encodeTeamsSyncCursor({
      v: 1,
      phase: "messages",
      teams: [{ id: "team-1" }],
      teamsNext: null,
      channelTeamIdx: 1,
      channelsByTeam: { "team-1": ["chan-1"] },
      chanNext: null,
      pairs: [{ teamId: "team-1", channelId: "chan-1" }],
      pairIdx: 0,
      deltaByKey: {},
    });

    const r1 = await syncable.sync(ctx, messagesCursor);
    expect(r1.itemsUpserted).toBe(1);

    const row = db
      .query<{ body_complete: number; len: number }, []>(
        "SELECT body_complete, length(body) AS len FROM item WHERE service = 'teams'",
      )
      .get();
    expect(row?.len).toBe(16_384);
    expect(row?.body_complete).toBe(0); // was 1 — the bug
  });
});
