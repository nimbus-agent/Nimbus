import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Token-getter must be mocked BEFORE importing slack-sync so the
// `getValidSlackAccessToken` reference is replaced at module-load time.
const tokenState: { throwNext: boolean; value: string } = {
  throwNext: false,
  value: "slack-stub-token",
};
mock.module("../../../src/auth/slack-access-token.ts", () => ({
  getValidSlackAccessToken: async (): Promise<string> => {
    if (tokenState.throwNext) {
      throw new Error("refresh failed");
    }
    return tokenState.value;
  },
}));

import { createSlackSyncable } from "../../../src/connectors/slack-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureSlackMcpRunning: async (): Promise<void> => {} };

const CURSOR_PREFIX = "nimbus-slk1:";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

let fixture: ConnectorSyncFixture;

beforeEach(async () => {
  fixture = createConnectorSyncFixture();
  fixture.fetchMock.install();
  tokenState.throwNext = false;
  tokenState.value = "slack-stub-token";
  // Seed the vault so the rawVault-null short-circuit doesn't fire in
  // tests that DO want to reach the rate-limiter / fetch path.
  await fixture.vault.set("slack.oauth", "slack-stub-oauth-blob");
});

afterEach(() => {
  fixture.cleanup();
});

describe("slack-sync — credential short-circuits", () => {
  test("returns noop when vault credential is absent", async () => {
    const empty = createConnectorSyncFixture();
    empty.fetchMock.install();
    try {
      const syncable = createSlackSyncable(ENSURE_MCP);
      const res = await syncable.sync(empty.createSyncContext(), null);
      expect(res.hasMore).toBe(false);
      expect(res.itemsUpserted).toBe(0);
      expect(res.itemsDeleted).toBe(0);
      expect(empty.fetchMock.calls).toHaveLength(0);
    } finally {
      empty.cleanup();
    }
  });

  test("returns noop when vault stores empty string", async () => {
    const empty = createConnectorSyncFixture();
    empty.fetchMock.install();
    try {
      await empty.vault.set("slack.oauth", "");
      const syncable = createSlackSyncable(ENSURE_MCP);
      const res = await syncable.sync(empty.createSyncContext(), null);
      expect(res.hasMore).toBe(false);
      expect(empty.fetchMock.calls).toHaveLength(0);
    } finally {
      empty.cleanup();
    }
  });

  test("returns noop when token getter throws", async () => {
    tokenState.throwNext = true;
    const syncable = createSlackSyncable(ENSURE_MCP);
    const res = await syncable.sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
    expect(res.itemsUpserted).toBe(0);
    expect(fixture.fetchMock.calls).toHaveLength(0);
  });
});

describe("slack-sync — cursor decode", () => {
  // Each malformed cursor below produces `decodeCursor() === null`, which
  // falls back to the default `phase: "list"` state. We then stage an
  // empty channel list so the run ends without hitting any other path,
  // confirming the cursor was silently discarded.
  function stageListEmpty(): void {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
  }

  test("null cursor falls back to default list-phase state", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(2);
  });

  test("empty string cursor falls back to default", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), "");
    expect(res.hasMore).toBe(false);
  });

  test("wrong-prefix cursor falls back to default", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      "nimbus-other:abc",
    );
    expect(res.hasMore).toBe(false);
  });

  test("non-base64 cursor body falls back to default", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      `${CURSOR_PREFIX}!!!not-base64!!!`,
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor decoding to non-object falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor("string-not-object"),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor decoding to array falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor([1, 2, 3]),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with bad phase falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ phase: "bogus", floorTs: "0", ids: [], nextIdx: 0, hw: {} }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with non-string floorTs falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ phase: "list", floorTs: 42, ids: [], nextIdx: 0, hw: {} }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with empty floorTs falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ phase: "list", floorTs: "", ids: [], nextIdx: 0, hw: {} }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with non-string-array ids falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ phase: "list", floorTs: "1.0", ids: [1, 2], nextIdx: 0, hw: {} }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with negative nextIdx falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ phase: "list", floorTs: "1.0", ids: [], nextIdx: -1, hw: {} }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with non-integer nextIdx falls back", async () => {
    stageListEmpty();
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ phase: "list", floorTs: "1.0", ids: [], nextIdx: 1.5, hw: {} }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with non-object hw still decodes (hw defaults to empty)", async () => {
    // This branch covers slackDecodeHighWater's non-object input path.
    // The cursor decodes successfully with hw = {}.
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        phase: "history",
        floorTs: "1.0",
        ids: ["C1"],
        nextIdx: 0,
        hw: 42, // non-object -> {} via slackDecodeHighWater
        listCursor: null,
        histCursor: null,
        teamSubdomain: null,
      }),
    );
    expect(res.hasMore).toBe(false);
    expect(res.itemsUpserted).toBe(0);
  });

  test("cursor with hw containing mixed-type values keeps strings, nulls others", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        phase: "history",
        floorTs: "1.0",
        ids: ["C1"],
        nextIdx: 0,
        hw: { C1: "100.0", C2: 5, C3: null },
        listCursor: null,
        histCursor: null,
        teamSubdomain: null,
      }),
    );
    expect(res.hasMore).toBe(false);
    // The conversations.history body should include oldest=100.0 (hwVal for C1).
    const bodies = fixture.fetchMock.bodiesFor(
      "POST",
      "https://slack.com/api/conversations.history",
    );
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as Record<string, unknown>)["oldest"]).toBe("100.0");
  });

  test("floorTs is NaN-string -> reset to current depth window", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    // floorTs is a non-empty string but Number(floorTs) is NaN -> reset path.
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        phase: "history",
        floorTs: "not-a-number",
        ids: ["C1"],
        nextIdx: 0,
        hw: {},
        listCursor: null,
        histCursor: null,
        teamSubdomain: null,
      }),
    );
    expect(res.hasMore).toBe(false);
    const bodies = fixture.fetchMock.bodiesFor(
      "POST",
      "https://slack.com/api/conversations.history",
    );
    // hw was empty and histCursor null -> body should carry oldest = fresh floorTs.
    const body = bodies[0] as Record<string, unknown>;
    expect(typeof body["oldest"]).toBe("string");
    expect(Number(body["oldest"])).not.toBeNaN();
    expect(body["inclusive"]).toBe(true);
  });
});

describe("slack-sync — slackWebApi error shapes", () => {
  test("non-JSON response body parses to ok:false (JSON.parse catch path)", async () => {
    fixture.fetchMock.respondWithText("POST", "https://slack.com/api/auth.test", "not valid json");
    fixture.fetchMock.respondWithText(
      "POST",
      "https://slack.com/api/conversations.list",
      "<html>500</html>",
    );
    // The conversations.list non-JSON triggers the !res.ok throw inside
    // slackAdvanceListPhase because okField is undefined and res.ok matters.
    await expect(
      createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/conversations\.list/);
  });

  test("JSON parses to an array (not an object) treated as ok:false", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", [1, 2, 3]);
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    // auth.test returns an array -> slackTryFillTeamSubdomain bails to !ok branch
    // -> teamSubdomain stays null -> sync still completes through empty list.
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
  });

  test("HTTP 500 with ok:true in body still treated as ok:false (res.ok gate)", async () => {
    fixture.fetchMock.respond(
      "POST",
      "https://slack.com/api/auth.test",
      { ok: true },
      { status: 500 },
    );
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    // auth.test 500 -> !res.ok -> bail; sync completes through empty list.
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
  });
});

describe("slack-sync — slackTryFillTeamSubdomain", () => {
  test("auth.test ok with valid Slack URL extracts subdomain into permalinks", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", {
      ok: true,
      url: "https://acme.slack.com/",
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [{ id: "C1", is_member: true }],
      response_metadata: { next_cursor: "" },
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [{ ts: "1700000000.000100", text: "hi", user: "U1" }],
      response_metadata: { next_cursor: "" },
    });

    // Single sync call: list phase (finds C1) then immediately runs history
    // phase within the same invocation. The implementation only returns early
    // from the list phase when there is a next_cursor for pagination; when the
    // list is complete it falls through to the history phase in the same call.
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);

    const row = fixture.db
      .query<{ url: string | null }, []>("SELECT url FROM item WHERE service = 'slack' LIMIT 1")
      .get();
    expect(row?.url).toBe("https://acme.slack.com/archives/C1/p1700000000000100");
  });

  test("auth.test missing url field -> teamSubdomain stays null -> permalink null", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: true });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [{ id: "C1", is_member: true }],
      response_metadata: { next_cursor: "" },
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [{ ts: "1700000000.000200", text: "hi", user: "U1" }],
      response_metadata: { next_cursor: "" },
    });
    // Single sync call processes list then history in one invocation.
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ url: string | null }, []>("SELECT url FROM item WHERE service = 'slack' LIMIT 1")
      .get();
    expect(row?.url).toBeNull();
  });

  test("auth.test url has no .slack.com suffix -> teamSub null branch", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", {
      ok: true,
      url: "https://example.com/",
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
  });

  test("auth.test url is malformed (URL constructor throws) -> teamSubdomain stays null", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", {
      ok: true,
      url: "::::not-a-url::::",
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
  });

  test("auth.test url is empty string -> early return", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: true, url: "" });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
  });

  test("auth.test url is non-string -> early return", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: true, url: 42 });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
  });

  test("cursor carries teamSubdomain -> auth.test is not called", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    // No auth.test stub: if it gets called, MockFetch throws "no stub matched".
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        phase: "list",
        floorTs: "1.0",
        ids: [],
        nextIdx: 0,
        hw: {},
        listCursor: null,
        histCursor: null,
        teamSubdomain: "acme",
      }),
    );
    expect(res.hasMore).toBe(false);
    const authCalls = fixture.fetchMock.calls.filter((c) => c.url.includes("auth.test"));
    expect(authCalls).toHaveLength(0);
  });
});

describe("slack-sync — list phase", () => {
  test("happy path: non-empty next_cursor returns 'return' with hasMore=true", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [
        { id: "C1", is_member: true },
        { id: "C2", is_member: false }, // filtered out
        { id: "", is_member: true }, // empty id filtered out
        "not-a-record", // not a record - skipped
        { foo: "no-id" }, // record without id - skipped
      ],
      response_metadata: { next_cursor: "page2" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(true);
    expect(res.itemsUpserted).toBe(0);
    // Cursor carries forward listCursor=page2 and ids=[C1]
    expect(res.cursor).toStartWith("nimbus-slk1:");
  });

  test("ratelimited list error -> throws (covers penalise-branch)", async () => {
    // The `if (error === "ratelimited") { rateLimiter.penalise(...) }` line
    // executes here; line-coverage records it without needing to inspect
    // the limiter's internal bucket state. ProviderRateLimiter has no read
    // accessor and adding one would scope-creep into the 85% sync gate.
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: false,
      error: "ratelimited",
    });
    await expect(
      createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/conversations.list.*ratelimited/);
  });

  test("non-ratelimited list error -> throws (covers no-penalty branch)", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: false,
      error: "internal_error",
    });
    await expect(
      createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/conversations.list/);
  });

  test("done_list with non-empty unique sort - transitions to history with hasMore=true", async () => {
    // NOTE: production falls from list → history in the same call when done_list
    // returns with non-empty ids. So a single sync call runs both phases for the
    // first channel. We assert the first history call hit C1 (alpha-first after
    // dedup of [C2, C1, C1] -> [C1, C2]).
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [
        { id: "C2", is_member: true },
        { id: "C1", is_member: true },
        { id: "C1", is_member: true }, // duplicate -> uniqued
      ],
      response_metadata: { next_cursor: "" },
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });

    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    // After single call: list ran (done_list with [C1, C2]), then history ran for
    // C1 (no messages), advanced nextIdx to 1, returned hasMore=true because 1 < 2.
    expect(res.hasMore).toBe(true);
    const histCalls = fixture.fetchMock.bodiesFor(
      "POST",
      "https://slack.com/api/conversations.history",
    );
    expect(histCalls).toHaveLength(1);
    expect((histCalls[0] as Record<string, unknown>)["channel"]).toBe("C1");
  });

  test("empty channels -> done_list with hasMore=false", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
    expect(res.itemsUpserted).toBe(0);
  });

  test("missing response_metadata -> defaults to empty next_cursor -> done_list", async () => {
    // production: meta = asRecord(json["response_metadata"]) -> undefined when missing
    // -> nextList = "" (the else branch). With non-empty ids, done_list falls through
    // to history. Stage an empty-message history so the run completes cleanly.
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [{ id: "C1", is_member: true }],
    });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    // After single call: list (done_list, ids=[C1]) -> history C1 -> nextIdx=1,
    // hasMore = 1 < 1 = false.
    expect(res.hasMore).toBe(false);
    expect(res.itemsUpserted).toBe(0);
  });

  test("listCursor non-empty in cursor is forwarded as cursor param", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.list", {
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        phase: "list",
        floorTs: "1.0",
        ids: [], // empty so done_list with empty channels -> no history needed
        nextIdx: 0,
        hw: {},
        listCursor: "page-N",
        histCursor: null,
        teamSubdomain: null,
      }),
    );
    const bodies = fixture.fetchMock.bodiesFor("POST", "https://slack.com/api/conversations.list");
    expect((bodies[0] as Record<string, unknown>)["cursor"]).toBe("page-N");
  });
});

describe("slack-sync — history phase", () => {
  function historyCursor(
    overrides: Partial<{
      floorTs: string;
      ids: string[];
      nextIdx: number;
      hw: Record<string, string | null>;
      histCursor: string | null;
      teamSubdomain: string | null;
    }>,
  ): string {
    return encodeCursor({
      phase: "history",
      floorTs: "1.0",
      ids: ["C1"],
      nextIdx: 0,
      hw: {},
      listCursor: null,
      histCursor: null,
      teamSubdomain: null,
      ...overrides,
    });
  }

  test("ids=[''] (empty channel slot) -> early return with hasMore=false", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor({ ids: [""] }),
    );
    expect(res.hasMore).toBe(false);
    // conversations.history NOT called
    const histCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.includes("conversations.history"),
    );
    expect(histCalls).toHaveLength(0);
  });

  test("history ratelimited error -> throws (covers penalise-branch)", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: false,
      error: "ratelimited",
    });
    await expect(
      createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor({})),
    ).rejects.toThrow(/conversations\.history.*ratelimited/);
  });

  test("history non-ratelimited error -> throws (covers no-penalty branch)", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: false,
      error: "boom",
    });
    await expect(
      createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor({})),
    ).rejects.toThrow(/conversations\.history/);
  });

  test("hwVal set -> request body carries oldest=hwVal, inclusive=false", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor({ hw: { C1: "999.0" } }),
    );
    const body = fixture.fetchMock.bodiesFor(
      "POST",
      "https://slack.com/api/conversations.history",
    )[0] as Record<string, unknown>;
    expect(body["oldest"]).toBe("999.0");
    expect(body["inclusive"]).toBe(false);
  });

  test("histCursor non-empty -> request body carries cursor, omits oldest", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor({ histCursor: "next-hist-page" }),
    );
    const body = fixture.fetchMock.bodiesFor(
      "POST",
      "https://slack.com/api/conversations.history",
    )[0] as Record<string, unknown>;
    expect(body["cursor"]).toBe("next-hist-page");
    expect(body["oldest"]).toBeUndefined();
  });

  test("paginated history -> next_cursor non-empty returns hasMore=true with same channel", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [{ ts: "100.000010", text: "m1", user: "U1" }],
      response_metadata: { next_cursor: "hist-page-2" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor({}),
    );
    expect(res.hasMore).toBe(true);
    expect(res.itemsUpserted).toBe(1);
  });

  test("end of history -> advances nextIdx, hasMore depends on remaining channels", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [{ ts: "200.000020", text: "m2", user: "U2" }],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor({ ids: ["C1", "C2"], nextIdx: 0 }),
    );
    expect(res.hasMore).toBe(true); // C2 still pending
    expect(res.itemsUpserted).toBe(1);
  });

  test("last channel exhausted -> hasMore=false", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor({ ids: ["C1"], nextIdx: 0 }),
    );
    expect(res.hasMore).toBe(false);
  });
});

describe("slack-sync — message indexing skip paths", () => {
  function stageHistory(messages: unknown[]): void {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages,
      response_metadata: { next_cursor: "" },
    });
  }
  function historyCursor(): string {
    return encodeCursor({
      phase: "history",
      floorTs: "1.0",
      ids: ["C1"],
      nextIdx: 0,
      hw: {},
      listCursor: null,
      histCursor: null,
      teamSubdomain: null,
    });
  }

  test("messages not an array -> 0 upserts", async () => {
    stageHistory("not-array" as unknown as unknown[]);
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor(),
    );
    expect(res.itemsUpserted).toBe(0);
  });

  test("non-record array entries skipped", async () => {
    stageHistory(["string-entry", 42, null]);
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor(),
    );
    expect(res.itemsUpserted).toBe(0);
  });

  test("ts missing or empty skipped", async () => {
    stageHistory([
      { text: "no ts", user: "U1" },
      { ts: "", text: "empty ts", user: "U1" },
    ]);
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor(),
    );
    expect(res.itemsUpserted).toBe(0);
  });

  test("subtype other than thread_broadcast skipped", async () => {
    stageHistory([{ ts: "100.0", text: "join", user: "U1", subtype: "channel_join" }]);
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor(),
    );
    expect(res.itemsUpserted).toBe(0);
  });

  test("subtype=thread_broadcast indexed", async () => {
    stageHistory([{ ts: "100.0", text: "broadcast", user: "U1", subtype: "thread_broadcast" }]);
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      historyCursor(),
    );
    expect(res.itemsUpserted).toBe(1);
  });

  test("non-string text -> preview empty, title is '(no text)'", async () => {
    stageHistory([{ ts: "100.0", text: 42, user: "U1" }]);
    await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor());
    const row = fixture.db
      .query<{ title: string; body_preview: string | null }, []>(
        "SELECT title, body_preview FROM item WHERE service = 'slack' LIMIT 1",
      )
      .get();
    expect(row?.body_preview).toBe("");
    expect(row?.title).toBe("(no text)");
  });

  test("non-string user -> authorId null", async () => {
    stageHistory([{ ts: "100.0", text: "hi", user: 42 }]);
    await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor());
    const row = fixture.db
      .query<{ author_id: string | null }, []>(
        "SELECT author_id FROM item WHERE service = 'slack' LIMIT 1",
      )
      .get();
    expect(row?.author_id).toBeNull();
  });

  test("empty user string -> authorId null", async () => {
    stageHistory([{ ts: "100.0", text: "hi", user: "" }]);
    await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor());
    const row = fixture.db
      .query<{ author_id: string | null }, []>(
        "SELECT author_id FROM item WHERE service = 'slack' LIMIT 1",
      )
      .get();
    expect(row?.author_id).toBeNull();
  });

  test("non-finite ts number -> modifiedAt falls back to now", async () => {
    // ts="abc" -> parseFloat -> NaN -> non-finite -> modifiedAt=now
    stageHistory([{ ts: "abc", text: "hi", user: "U1" }]);
    const beforeMs = Date.now();
    await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor());
    const afterMs = Date.now();
    const row = fixture.db
      .query<{ modified_at: number }, []>(
        "SELECT modified_at FROM item WHERE service = 'slack' LIMIT 1",
      )
      .get();
    expect(row?.modified_at).toBeGreaterThanOrEqual(beforeMs);
    expect(row?.modified_at).toBeLessThanOrEqual(afterMs);
  });

  test("thread_ts string preserved in metadata; non-string -> null", async () => {
    stageHistory([
      { ts: "100.0", text: "in-thread", user: "U1", thread_ts: "99.0" },
      { ts: "101.0", text: "no-thread", user: "U1", thread_ts: 42 },
    ]);
    await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor());
    const rows = fixture.db
      .query<{ metadata: string }, []>(
        "SELECT metadata FROM item WHERE service = 'slack' ORDER BY external_id",
      )
      .all();
    expect(rows).toHaveLength(2);
    const meta0 = JSON.parse(rows[0].metadata) as Record<string, unknown>;
    const meta1 = JSON.parse(rows[1].metadata) as Record<string, unknown>;
    expect(meta0["thread_ts"]).toBe("99.0");
    expect(meta1["thread_ts"]).toBeNull();
  });

  test("title sliced to 512 chars on very long messages", async () => {
    const long = "x".repeat(1024);
    stageHistory([{ ts: "100.0", text: long, user: "U1" }]);
    await createSlackSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), historyCursor());
    const row = fixture.db
      .query<{ title: string; body_preview: string | null }, []>(
        "SELECT title, body_preview FROM item WHERE service = 'slack' LIMIT 1",
      )
      .get();
    expect(row?.title.length).toBeLessThanOrEqual(120); // shortIndexedMessageTitleFromPreview caps title at ~118 chars
    expect(row?.body_preview?.length).toBe(512); // preview clipped at 512
  });

  test("maxTs updated across batch -> stored as hwVal in next cursor", async () => {
    fixture.fetchMock.respond("POST", "https://slack.com/api/auth.test", { ok: false });
    fixture.fetchMock.respond("POST", "https://slack.com/api/conversations.history", {
      ok: true,
      messages: [
        { ts: "100.0", text: "earlier", user: "U1" },
        { ts: "200.0", text: "later", user: "U1" },
        { ts: "150.0", text: "middle", user: "U1" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const res = await createSlackSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        phase: "history",
        floorTs: "1.0",
        ids: ["C1"],
        nextIdx: 0,
        hw: {},
        listCursor: null,
        histCursor: null,
        teamSubdomain: null,
      }),
    );
    expect(res.itemsUpserted).toBe(3);
    // Decode the returned cursor and verify hw.C1 == "200.0"
    const raw = res.cursor!.slice("nimbus-slk1:".length);
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      hw: Record<string, string | null>;
    };
    expect(decoded.hw["C1"]).toBe("200.0");
  });
});
