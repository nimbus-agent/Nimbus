import { describe, expect, test } from "bun:test";
import { itemPrimaryKey } from "../../../index/item-store.ts";
import { createOAuthConnectorTestSetup } from "../../../testing/bun-test-support.ts";
import {
  deltaKey,
  flattenPairs,
  type GraphTeamsMessage,
  nextMessageCursorFromDeltaPage,
  parseChannelsListPage,
  parseTeamsListPage,
  TEAMS_GRAPH_BASE,
  TEAMS_PAGE_SIZE,
  TEAMS_SERVICE_ID,
  upsertChannelMessage,
} from "./api.ts";
import type { TeamsSyncCursorV1 } from "./cursor.ts";
import { encodeTeamsSyncCursor } from "./cursor.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe("teams/api constants", () => {
  test("TEAMS_SERVICE_ID is teams", () => {
    expect(TEAMS_SERVICE_ID).toBe("teams");
  });
  test("TEAMS_GRAPH_BASE points to Graph v1.0", () => {
    expect(TEAMS_GRAPH_BASE).toBe("https://graph.microsoft.com/v1.0");
  });
  test("TEAMS_PAGE_SIZE is a positive integer", () => {
    expect(typeof TEAMS_PAGE_SIZE).toBe("number");
    expect(TEAMS_PAGE_SIZE).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// deltaKey
// ---------------------------------------------------------------------------
describe("deltaKey", () => {
  test("joins teamId and channelId with |", () => {
    expect(deltaKey("t1", "c1")).toBe("t1|c1");
  });
  test("works with empty strings", () => {
    expect(deltaKey("", "")).toBe("|");
  });
});

// ---------------------------------------------------------------------------
// flattenPairs
// ---------------------------------------------------------------------------
describe("flattenPairs", () => {
  test("empty input yields empty array", () => {
    expect(flattenPairs({})).toEqual([]);
  });

  test("single team single channel", () => {
    expect(flattenPairs({ t1: ["c1"] })).toEqual([{ teamId: "t1", channelId: "c1" }]);
  });

  test("multiple teams sorted lexicographically", () => {
    const result = flattenPairs({ tb: ["c1"], ta: ["c2"] });
    expect(result[0]?.teamId).toBe("ta");
    expect(result[1]?.teamId).toBe("tb");
  });

  test("channels within team sorted lexicographically", () => {
    const result = flattenPairs({ t1: ["cb", "ca"] });
    expect(result[0]?.channelId).toBe("ca");
    expect(result[1]?.channelId).toBe("cb");
  });

  test("team with no channels (undefined via ?? [])", () => {
    // Use a type-safe cast via unknown to mimic a record with an undefined entry
    const input = { t1: undefined } as unknown as Record<string, string[]>;
    const result = flattenPairs(input);
    expect(result).toEqual([]);
  });

  test("multiple teams multiple channels cross product", () => {
    const result = flattenPairs({ ta: ["c1", "c2"], tb: ["c3"] });
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ teamId: "ta", channelId: "c1" });
    expect(result[1]).toEqual({ teamId: "ta", channelId: "c2" });
    expect(result[2]).toEqual({ teamId: "tb", channelId: "c3" });
  });
});

// ---------------------------------------------------------------------------
// parseTeamsListPage
// ---------------------------------------------------------------------------
describe("parseTeamsListPage", () => {
  test("null input returns empty ids and null nextLink (L110 branch: not array)", () => {
    const result = parseTeamsListPage(null);
    expect(result.ids).toEqual([]);
    expect(result.nextLink).toBeNull();
  });

  test("non-object input (string) returns empty", () => {
    const result = parseTeamsListPage("not-an-object");
    expect(result.ids).toEqual([]);
    expect(result.nextLink).toBeNull();
  });

  test("empty object (no value key) returns empty", () => {
    const result = parseTeamsListPage({});
    expect(result.ids).toEqual([]);
    expect(result.nextLink).toBeNull();
  });

  test("value is not an array (L110 branch: else path)", () => {
    const result = parseTeamsListPage({ value: "not-an-array" });
    expect(result.ids).toEqual([]);
    expect(result.nextLink).toBeNull();
  });

  test("value array with valid id", () => {
    const result = parseTeamsListPage({ value: [{ id: "t1" }] });
    expect(result.ids).toEqual([{ id: "t1" }]);
    expect(result.nextLink).toBeNull();
  });

  test("value array: item with empty id is skipped (L114 branch)", () => {
    const result = parseTeamsListPage({ value: [{ id: "" }, { id: "t2" }] });
    expect(result.ids).toEqual([{ id: "t2" }]);
  });

  test("value array: item with non-string id is skipped (L114 branch: typeof !== string)", () => {
    const result = parseTeamsListPage({ value: [{ id: 42 }, { id: "t3" }] });
    expect(result.ids).toEqual([{ id: "t3" }]);
  });

  test("value array: item with no id field is skipped", () => {
    const result = parseTeamsListPage({ value: [{ name: "foo" }, { id: "t4" }] });
    expect(result.ids).toEqual([{ id: "t4" }]);
  });

  test("value array: null item treated as empty object — skipped (L113 branch)", () => {
    const result = parseTeamsListPage({ value: [null, { id: "t5" }] });
    expect(result.ids).toEqual([{ id: "t5" }]);
  });

  test("nextLink present and non-empty (L133 branch: string path)", () => {
    const result = parseTeamsListPage({
      value: [],
      "@odata.nextLink": "https://graph.example.com/next",
    });
    expect(result.nextLink).toBe("https://graph.example.com/next");
  });

  test("nextLink empty string → null (L133 branch: empty string)", () => {
    const result = parseTeamsListPage({ value: [], "@odata.nextLink": "" });
    expect(result.nextLink).toBeNull();
  });

  test("nextLink is a number → null (L133 branch: not string)", () => {
    const result = parseTeamsListPage({ value: [], "@odata.nextLink": 999 });
    expect(result.nextLink).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseChannelsListPage
// ---------------------------------------------------------------------------
describe("parseChannelsListPage", () => {
  test("null input returns empty (L133-like branch)", () => {
    const result = parseChannelsListPage(null);
    expect(result.channelIds).toEqual([]);
    expect(result.nextLink).toBeNull();
  });

  test("value not array (L133 branch)", () => {
    const result = parseChannelsListPage({ value: 42 });
    expect(result.channelIds).toEqual([]);
    expect(result.nextLink).toBeNull();
  });

  test("archived channel excluded (L138 branch: archived === true)", () => {
    const result = parseChannelsListPage({
      value: [
        { id: "c1", isArchived: true },
        { id: "c2", isArchived: false },
      ],
    });
    expect(result.channelIds).toEqual(["c2"]);
  });

  test("channel with empty id excluded (L138 branch: id === '')", () => {
    const result = parseChannelsListPage({
      value: [{ id: "", isArchived: false }, { id: "c3" }],
    });
    expect(result.channelIds).toEqual(["c3"]);
  });

  test("channel with non-string id excluded (L138 branch: typeof id !== string)", () => {
    const result = parseChannelsListPage({
      value: [{ id: 99 }, { id: "c4" }],
    });
    expect(result.channelIds).toEqual(["c4"]);
  });

  test("null item in value treated as empty object — excluded", () => {
    const result = parseChannelsListPage({ value: [null, { id: "c5" }] });
    expect(result.channelIds).toEqual(["c5"]);
  });

  test("nextLink non-empty string is returned (L146 branch)", () => {
    const result = parseChannelsListPage({
      value: [],
      "@odata.nextLink": "https://next.link",
    });
    expect(result.nextLink).toBe("https://next.link");
  });

  test("nextLink empty string → null (L146 branch)", () => {
    const result = parseChannelsListPage({ value: [], "@odata.nextLink": "" });
    expect(result.nextLink).toBeNull();
  });

  test("nextLink non-string → null", () => {
    const result = parseChannelsListPage({ value: [], "@odata.nextLink": false });
    expect(result.nextLink).toBeNull();
  });

  test("isArchived undefined is treated as not archived (L138: archived !== true)", () => {
    const result = parseChannelsListPage({ value: [{ id: "c6" }] });
    expect(result.channelIds).toEqual(["c6"]);
  });
});

// ---------------------------------------------------------------------------
// nextMessageCursorFromDeltaPage
// ---------------------------------------------------------------------------
function makeBaseState(overrides?: Partial<TeamsSyncCursorV1>): TeamsSyncCursorV1 {
  return {
    v: 1,
    phase: "messages",
    teams: [],
    teamsNext: null,
    channelTeamIdx: 0,
    channelsByTeam: {},
    chanNext: null,
    pairs: [
      { teamId: "t1", channelId: "c1" },
      { teamId: "t1", channelId: "c2" },
    ],
    pairIdx: 0,
    deltaByKey: {},
    ...overrides,
  };
}

describe("nextMessageCursorFromDeltaPage", () => {
  test("nextLink present: stores nextLink, hasMore=true (L158 branch)", () => {
    const state = makeBaseState();
    const page = { "@odata.nextLink": "https://next.page" };
    const encode = encodeTeamsSyncCursor;
    const result = nextMessageCursorFromDeltaPage(page, state, "t1|c1", encode);
    expect(result.hasMore).toBe(true);
    expect(result.stored).not.toBeNull();
  });

  test("nextLink empty string: falls through to deltaLink check (L158 branch: else path)", () => {
    const state = makeBaseState();
    const page = {
      "@odata.nextLink": "",
      "@odata.deltaLink": "https://delta.link",
    };
    const result = nextMessageCursorFromDeltaPage(page, state, "t1|c1", encodeTeamsSyncCursor);
    // deltaLink branch: pairIdx advances from 0 → 1 (< pairs.length=2), hasMore=true
    expect(result.hasMore).toBe(true);
    expect(result.stored).not.toBeNull();
  });

  // pairs.length is 2 in the base state, so pairIdx 1 is the last pair (hasMore=false); an empty
  // deltaLink is not a deltaLink at all and falls through to the last branch (L165).
  test.each([
    [
      "deltaLink present, pairIdx still < pairs.length (L165 branch)",
      0,
      "https://delta.link",
      true,
    ],
    [
      "deltaLink present, pairIdx reaches pairs.length → pairIdx resets to 0 (L168 branch)",
      1,
      "https://delta.link",
      false,
    ],
    ["deltaLink empty string → falls through to the last branch (L165)", 0, "", true],
  ])("%s: hasMore=%s", (_label, pairIdx, deltaLink, expected) => {
    const state = makeBaseState({ pairIdx });
    const page = { "@odata.deltaLink": deltaLink };
    const result = nextMessageCursorFromDeltaPage(page, state, "t1|c1", encodeTeamsSyncCursor);
    expect(result.hasMore).toBe(expected);
  });

  test("neither nextLink nor deltaLink: falls through to last branch (L179)", () => {
    const state = makeBaseState({ pairIdx: 0 });
    const page = {};
    const result = nextMessageCursorFromDeltaPage(page, state, "t1|c1", encodeTeamsSyncCursor);
    // pairIdx advances 0 → 1 < 2, hasMore=true
    expect(result.hasMore).toBe(true);
    expect(result.stored).not.toBeNull();
  });

  test("last branch, pairIdx reaches pairs.length: pairIdx resets, hasMore=false (L181 branch)", () => {
    const state = makeBaseState({ pairIdx: 1 }); // pairIdx+1 = 2 >= 2
    const page = {};
    const result = nextMessageCursorFromDeltaPage(page, state, "t1|c1", encodeTeamsSyncCursor);
    expect(result.hasMore).toBe(false);
  });

  test("nextLink non-string number: falls through (L158: typeof !== string)", () => {
    const state = makeBaseState();
    const page = { "@odata.nextLink": 999 } as unknown as { "@odata.nextLink"?: string };
    const result = nextMessageCursorFromDeltaPage(
      page as Parameters<typeof nextMessageCursorFromDeltaPage>[0],
      state,
      "t1|c1",
      encodeTeamsSyncCursor,
    );
    // No nextLink, no deltaLink → last branch, pairIdx 0→1 < 2, hasMore=true
    expect(result.hasMore).toBe(true);
  });

  test("single pair state: deltaLink → pairIdx 0+1=1 >= 1, hasMore=false", () => {
    const state = makeBaseState({
      pairs: [{ teamId: "t1", channelId: "c1" }],
      pairIdx: 0,
    });
    const page = { "@odata.deltaLink": "https://delta.link" };
    const result = nextMessageCursorFromDeltaPage(page, state, "t1|c1", encodeTeamsSyncCursor);
    expect(result.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// upsertChannelMessage
// ---------------------------------------------------------------------------
describe("upsertChannelMessage", () => {
  test("missing id (undefined): returns without upsert (L49 branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = {};
    upsertChannelMessage(ctx, "t1", "c1", m, Date.now());
    const row = db.query("SELECT count(*) as n FROM item WHERE service = 'teams'").get() as {
      n: number;
    };
    expect(row.n).toBe(0);
  });

  test("empty string id: returns without upsert (L49 branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = { id: "" };
    upsertChannelMessage(ctx, "t1", "c1", m, Date.now());
    const row = db.query("SELECT count(*) as n FROM item WHERE service = 'teams'").get() as {
      n: number;
    };
    expect(row.n).toBe(0);
  });

  test("body.content is a string: used as preview source (L53 branch: body defined, content string)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = {
      id: "msg1",
      body: { content: "Hello world message", contentType: "text" },
    };
    upsertChannelMessage(ctx, "t1", "c1", m, 1_000_000);
    const row = db
      .query("SELECT body_preview FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg1")) as { body_preview: string | null } | null;
    expect(row).not.toBeNull();
    expect(row?.body_preview).not.toBe("");
  });

  test("body undefined: content defaults to empty string (L53 branch: body undefined)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = { id: "msg2" };
    upsertChannelMessage(ctx, "t1", "c1", m, 1_000_000);
    const row = db
      .query("SELECT body_preview, title FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg2")) as {
      body_preview: string | null;
      title: string;
    } | null;
    expect(row).not.toBeNull();
    // No preview, no fromName → title is "(message)" (L63/L64 branch)
    expect(row?.title).toBe("(message)");
  });

  test("displayName non-empty: fromName set (L57 branch: defined and non-empty)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = {
      id: "msg3",
      from: { user: { displayName: "Alice" } },
    };
    upsertChannelMessage(ctx, "t1", "c1", m, 1_000_000);
    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg3")) as { title: string } | null;
    expect(row).not.toBeNull();
    // No body content, fromName=Alice → L66: "Message from Alice"
    expect(row?.title).toBe("Message from Alice");
  });

  test("displayName empty string: fromName remains null (L57 branch: displayName === '')", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = {
      id: "msg4",
      from: { user: { displayName: "" } },
    };
    upsertChannelMessage(ctx, "t1", "c1", m, 1_000_000);
    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg4")) as { title: string } | null;
    // displayName is empty → fromName stays null → title is "(message)" (L63/L64)
    expect(row?.title).toBe("(message)");
  });

  test("displayName undefined: fromName remains null (L57 branch: undefined)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = {
      id: "msg5",
      from: { user: { id: "uid-5" } },
    };
    upsertChannelMessage(ctx, "t1", "c1", m, 1_000_000);
    // displayName undefined → fromName null; graphUserId "uid-5" is set → authorId resolved
    const row = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg5")) as { author_id: string | null } | null;
    expect(row).not.toBeNull();
    // graphUserId is non-empty → resolvePersonForSync called → non-null
    expect(row?.author_id).not.toBeNull();
  });

  test("preview non-empty: title derived from preview (L61 branch: trim !== '')", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = {
      id: "msg6",
      body: { content: "This is the message body text for preview", contentType: "text" },
    };
    upsertChannelMessage(ctx, "t1", "c1", m, 1_000_000);
    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg6")) as { title: string } | null;
    expect(row).not.toBeNull();
    // preview.trim() !== '' → L62: shortIndexedMessageTitleFromPreview
    expect(row?.title).not.toBe("(message)");
    expect(row?.title.length).toBeGreaterThan(0);
  });

  test("title exceeding 512 chars is truncated (L69 branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    // Generate a fromName long enough to push title > 512 (no body, from path L66: "Message from <name>")
    const longName = "A".repeat(520);
    const m: GraphTeamsMessage = {
      id: "msg7",
      from: { user: { displayName: longName } },
    };
    upsertChannelMessage(ctx, "t1", "c1", m, 1_000_000);
    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg7")) as { title: string } | null;
    expect(row).not.toBeNull();
    expect(row?.title).toHaveLength(512);
  });

  test("graphUserId empty string: authorId is null (L75 branch: graphUserId === '')", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = {
      id: "msg8",
      from: { user: { displayName: "Bob", id: "" } },
    };
    upsertChannelMessage(ctx, "t1", "c1", m, 1_000_000);
    const row = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg8")) as { author_id: string | null } | null;
    // graphUserId="" → authorId=null (L75 branch: else null)
    expect(row?.author_id).toBeNull();
  });

  test("graphUserId undefined: authorId is null (L75 branch: graphUserId undefined)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = {
      id: "msg9",
      from: { user: { displayName: "Carol" } },
    };
    upsertChannelMessage(ctx, "t1", "c1", m, 1_000_000);
    const row = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg9")) as { author_id: string | null } | null;
    expect(row?.author_id).toBeNull();
  });

  test("lastModifiedDateTime defined: used for modifiedAt (L78 branch: defined path)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const isoTs = "2024-01-15T10:00:00Z";
    const m: GraphTeamsMessage = {
      id: "msg10",
      lastModifiedDateTime: isoTs,
      body: { content: "body text" },
    };
    upsertChannelMessage(ctx, "t1", "c1", m, 9_999_999);
    const row = db
      .query("SELECT modified_at FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg10")) as { modified_at: number } | null;
    expect(row).not.toBeNull();
    // Should NOT be the fallback value
    expect(row?.modified_at).not.toBe(9_999_999);
  });

  test("lastModifiedDateTime undefined, createdDateTime defined: used via ?? (L78 branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = {
      id: "msg11",
      createdDateTime: "2024-02-20T12:00:00Z",
    };
    upsertChannelMessage(ctx, "t1", "c1", m, 8_888_888);
    const row = db
      .query("SELECT modified_at FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg11")) as { modified_at: number } | null;
    expect(row).not.toBeNull();
    expect(row?.modified_at).not.toBe(8_888_888);
  });

  test("both undefined: modifiedAt falls back to now (L78 branch: both undefined)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const now = 7_777_777;
    const m: GraphTeamsMessage = { id: "msg12" };
    upsertChannelMessage(ctx, "t1", "c1", m, now);
    const row = db
      .query("SELECT modified_at FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg12")) as { modified_at: number } | null;
    expect(row?.modified_at).toBe(now);
  });

  test("from is undefined: no displayName, no graphUserId (L57/L75 branches, from=undefined)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = { id: "msg13", body: { content: "" } };
    upsertChannelMessage(ctx, "t1", "c1", m, 1_000_000);
    const row = db
      .query("SELECT title, author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg13")) as {
      title: string;
      author_id: string | null;
    } | null;
    expect(row?.title).toBe("(message)");
    expect(row?.author_id).toBeNull();
  });

  test("graphUserId defined and displayName null: displayName fallback to graphUserId (L78 in resolvePersonForSync)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "teams");
    const m: GraphTeamsMessage = {
      id: "msg14",
      from: { user: { id: "gid-14" } }, // displayName undefined → fromName=null → displayName fallback to graphUserId
    };
    upsertChannelMessage(ctx, "t1", "c1", m, 1_000_000);
    const row = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("teams", "t1:c1:msg14")) as { author_id: string | null } | null;
    expect(row?.author_id).not.toBeNull();
  });
});
