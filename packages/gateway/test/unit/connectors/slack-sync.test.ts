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
