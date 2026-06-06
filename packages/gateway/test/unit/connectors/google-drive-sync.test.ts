import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const tokenState: { throwNext: boolean; value: string } = {
  throwNext: false,
  value: "google-drive-stub-token",
};
mock.module("../../../src/auth/google-access-token.ts", () => ({
  getValidGoogleAccessToken: async (): Promise<string> => {
    if (tokenState.throwNext) {
      throw new Error("refresh failed");
    }
    return tokenState.value;
  },
}));

import { createGoogleDriveSyncable } from "../../../src/connectors/google-drive-sync.ts";
import { itemPrimaryKey } from "../../../src/index/item-store.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureGoogleDriveRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-gdrv1:";

const START_TOKEN_RE = /^https:\/\/www\.googleapis\.com\/drive\/v3\/changes\/startPageToken\?/;
const FILES_LIST_RE = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\?/;
const CHANGES_LIST_RE = /^https:\/\/www\.googleapis\.com\/drive\/v3\/changes\?/;

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

let fixture: ConnectorSyncFixture;

beforeEach(() => {
  fixture = createConnectorSyncFixture();
  fixture.fetchMock.install();
  tokenState.throwNext = false;
  tokenState.value = "google-drive-stub-token";
});

afterEach(() => {
  fixture.cleanup();
});

describe("google-drive-sync — credential short-circuits", () => {
  test("token getter throws → sync() rejects, no fetches", async () => {
    tokenState.throwNext = true;
    const syncable = createGoogleDriveSyncable(ENSURE_MCP);
    await expect(syncable.sync(fixture.createSyncContext(), null)).rejects.toThrow(
      /refresh failed/,
    );
    expect(fixture.fetchMock.calls).toHaveLength(0);
  });

  test("token getter returns empty string → request fires with empty Bearer (no short-circuit)", async () => {
    tokenState.value = "";
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, { files: [] });
    const syncable = createGoogleDriveSyncable(ENSURE_MCP);
    await syncable.sync(fixture.createSyncContext(), null);
    expect(fixture.fetchMock.calls).toHaveLength(2);
    expect(fixture.fetchMock.calls[0]?.headers["authorization"]).toBe("Bearer");
  });
});

function stageLegacyFlowEmpty(): void {
  fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t-fresh" });
  fixture.fetchMock.respond("GET", FILES_LIST_RE, { files: [] });
}
function stageNullCursorFlowEmpty(): void {
  fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
  fixture.fetchMock.respond("GET", FILES_LIST_RE, { files: [] });
}

describe("google-drive-sync — cursor decode", () => {
  test("null cursor → initial flow: fetches startPageToken + files.list, transitions to drain", async () => {
    stageNullCursorFlowEmpty();
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(true);
    expect(res.cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from((res.cursor ?? "").slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({ v: 1, phase: "drain", changePage: "t0" });
  });

  test("empty string cursor → same as null cursor (initial flow)", async () => {
    stageNullCursorFlowEmpty();
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), "");
    expect(res.hasMore).toBe(true);
    expect(fixture.fetchMock.calls).toHaveLength(2);
    expect(fixture.fetchMock.calls[0]?.url).toMatch(START_TOKEN_RE);
    expect(fixture.fetchMock.calls[1]?.url).toMatch(FILES_LIST_RE);
  });

  test("wrong-prefix cursor → legacy migration path (treated as literal page token)", async () => {
    stageLegacyFlowEmpty();
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      "legacyOpaqueToken",
    );
    expect(res.hasMore).toBe(true);
    const filesCalls = fixture.fetchMock.calls.filter((c) => FILES_LIST_RE.test(c.url));
    expect(filesCalls).toHaveLength(1);
    expect(filesCalls[0]?.url).toContain("pageToken=legacyOpaqueToken");
  });

  test("non-base64 prefixed cursor → throws 'corrupt cursor'", async () => {
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        `${CURSOR_PREFIX}!!!not-base64!!!`,
      ),
    ).rejects.toThrow(/corrupt cursor/);
    expect(fixture.fetchMock.calls).toHaveLength(0);
  });

  test("prefixed cursor decoding to array → throws 'corrupt cursor'", async () => {
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        encodeCursor([1, 2, 3]),
      ),
    ).rejects.toThrow(/corrupt cursor/);
  });

  test("init_list cursor with missing t0 → throws 'corrupt cursor'", async () => {
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        encodeCursor({ v: 1, phase: "init_list", listToken: "abc" }),
      ),
    ).rejects.toThrow(/corrupt cursor/);
  });

  test("drain cursor with missing changePage → throws 'corrupt cursor'", async () => {
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        encodeCursor({ v: 1, phase: "drain" }),
      ),
    ).rejects.toThrow(/corrupt cursor/);
  });

  test("delta cursor with missing pageToken → throws 'corrupt cursor'", async () => {
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        encodeCursor({ v: 1, phase: "delta" }),
      ),
    ).rejects.toThrow(/corrupt cursor/);
  });

  test("prefixed cursor with unknown phase → throws 'corrupt cursor'", async () => {
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        encodeCursor({ v: 1, phase: "other", t0: "x" }),
      ),
    ).rejects.toThrow(/corrupt cursor/);
  });
});

describe("google-drive-sync — HTTP request paths", () => {
  test("sends Authorization: Bearer <token> header on startPageToken", async () => {
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, { files: [] });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const startCall = fixture.fetchMock.calls.find((c) => START_TOKEN_RE.test(c.url));
    expect(startCall).toBeDefined();
    expect(startCall?.headers["authorization"]).toBe("Bearer google-drive-stub-token");
  });

  test("sends Bearer header on files.list and includes q + pageSize=100 + fields", async () => {
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, { files: [] });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const filesCall = fixture.fetchMock.calls.find((c) => FILES_LIST_RE.test(c.url));
    expect(filesCall).toBeDefined();
    expect(filesCall?.headers["authorization"]).toBe("Bearer google-drive-stub-token");
    const url = filesCall?.url ?? "";
    expect(url).toContain("pageSize=100");
    expect(url).toContain("fields=");
    expect(url).toContain("q=");
    expect(url).toContain("trashed");
    expect(url).toContain("modifiedTime");
  });

  test("sends Bearer header on changes.list and includes pageSize=100 + pageToken + fields", async () => {
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, {
      changes: [],
      newStartPageToken: "next-delta",
    });
    const drainCursor = encodeCursor({ v: 1, phase: "drain", changePage: "tokABC" });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), drainCursor);
    const changesCall = fixture.fetchMock.calls.find((c) => CHANGES_LIST_RE.test(c.url));
    expect(changesCall).toBeDefined();
    expect(changesCall?.headers["authorization"]).toBe("Bearer google-drive-stub-token");
    const url = changesCall?.url ?? "";
    expect(url).toContain("pageSize=100");
    expect(url).toContain("pageToken=tokABC");
    expect(url).toContain("fields=");
    expect(url).toContain("removed");
    expect(url).toContain("fileId");
  });

  test("non-200 response → throws (Google error message surfaced)", async () => {
    fixture.fetchMock.respond(
      "GET",
      START_TOKEN_RE,
      { error: { code: 400, message: "Bad request foo" } },
      { status: 400 },
    );
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/Bad request foo/);
  });
});

describe("google-drive-sync — indexing skip paths", () => {
  test("file with missing id is skipped (no upsert)", async () => {
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [
        { name: "no-id.txt", mimeType: "text/plain" }, // missing id → skipped
        { id: "kept-1", name: "kept.txt", mimeType: "text/plain" }, // valid
      ],
    });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const rows = fixture.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'google_drive'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.external_id).toBe("kept-1");
  });

  test("file with missing name is skipped (no upsert)", async () => {
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [
        { id: "no-name", mimeType: "text/plain" }, // missing name → skipped
        { id: "kept-2", name: "kept.txt", mimeType: "text/plain" }, // valid
      ],
    });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const rows = fixture.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'google_drive'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.external_id).toBe("kept-2");
  });

  test("trashed file via changes.list → delete branch fires", async () => {
    fixture.db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, 'google_drive', 'file', 'gone-1', 'x', 'x', null, null, 1, null, '{}', 1, 0)`,
      [itemPrimaryKey("google_drive", "gone-1")],
    );
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, {
      changes: [{ removed: true, fileId: "gone-1" }],
      newStartPageToken: "next-delta",
    });
    const cur = encodeCursor({ v: 1, phase: "drain", changePage: "tokABC" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), cur);
    expect(res.itemsDeleted).toBe(1);
    const row = fixture.db
      .query("SELECT id FROM item WHERE id = ?")
      .get(itemPrimaryKey("google_drive", "gone-1"));
    expect(row).toBeNull();
  });

  test("changes.list removed change with no fileId is skipped", async () => {
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, {
      changes: [{ removed: true }],
      newStartPageToken: "next-delta",
    });
    const cur = encodeCursor({ v: 1, phase: "drain", changePage: "tokABC" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), cur);
    expect(res.itemsDeleted).toBe(0);
  });
});

describe("google-drive-sync — phase machine: init_list", () => {
  test("init_list cursor with listToken refetches files.list, no startPageToken call", async () => {
    fixture.fetchMock.respond("GET", FILES_LIST_RE, { files: [] });
    const cur = encodeCursor({ v: 1, phase: "init_list", t0: "tokA", listToken: "page2" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), cur);
    expect(res.hasMore).toBe(true);
    expect(fixture.fetchMock.calls.filter((c) => START_TOKEN_RE.test(c.url))).toHaveLength(0);
    const filesCalls = fixture.fetchMock.calls.filter((c) => FILES_LIST_RE.test(c.url));
    expect(filesCalls).toHaveLength(1);
    expect(filesCalls[0]?.url).toContain("pageToken=page2");
  });

  test("init_list page with nextPageToken → cursor preserves listToken (still in init_list)", async () => {
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [],
      nextPageToken: "page3",
    });
    const cur = encodeCursor({ v: 1, phase: "init_list", t0: "tokA", listToken: "page2" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), cur);
    expect(res.hasMore).toBe(true);
    expect(res.cursor).not.toBeNull();
    if (res.cursor === null) {
      throw new Error("cursor null");
    }
    const decoded = JSON.parse(
      Buffer.from(res.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({ v: 1, phase: "init_list", t0: "tokA", listToken: "page3" });
  });

  test("init_list final page (no nextPageToken) → transitions to drain phase with t0 captured", async () => {
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [
        {
          id: "final-1",
          name: "final.txt",
          mimeType: "application/vnd.google-apps.folder",
        },
      ],
    });
    const cur = encodeCursor({ v: 1, phase: "init_list", t0: "tokFinal", listToken: "lastPage" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), cur);
    expect(res.hasMore).toBe(true);
    if (res.cursor === null) {
      throw new Error("cursor null");
    }
    const decoded = JSON.parse(
      Buffer.from(res.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({ v: 1, phase: "drain", changePage: "tokFinal" });
    const row = fixture.db
      .query<{ type: string }, []>(
        "SELECT type FROM item WHERE service = 'google_drive' AND external_id = 'final-1'",
      )
      .get();
    expect(row?.type).toBe("folder");
  });
});

describe("google-drive-sync — phase machine: drain", () => {
  test("drain page with nextPageToken → cursor still in drain phase", async () => {
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, {
      changes: [],
      nextPageToken: "drain-page-2",
    });
    const cur = encodeCursor({ v: 1, phase: "drain", changePage: "tokABC" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), cur);
    expect(res.hasMore).toBe(true);
    if (res.cursor === null) {
      throw new Error("cursor null");
    }
    const decoded = JSON.parse(
      Buffer.from(res.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({ v: 1, phase: "drain", changePage: "drain-page-2" });
  });

  test("drain page with newStartPageToken (no nextPageToken) → transitions to delta phase", async () => {
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, {
      changes: [
        {
          file: {
            id: "drained-1",
            name: "drained.txt",
            mimeType: "text/plain",
          },
        },
      ],
      newStartPageToken: "next-delta",
    });
    const cur = encodeCursor({ v: 1, phase: "drain", changePage: "tokABC" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), cur);
    expect(res.hasMore).toBe(false);
    if (res.cursor === null) {
      throw new Error("cursor null");
    }
    const decoded = JSON.parse(
      Buffer.from(res.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({ v: 1, phase: "delta", pageToken: "next-delta" });
    const row = fixture.db
      .query<{ type: string }, []>(
        "SELECT type FROM item WHERE service = 'google_drive' AND external_id = 'drained-1'",
      )
      .get();
    expect(row?.type).toBe("file");
  });

  test("drain page with neither nextPageToken nor newStartPageToken → throws", async () => {
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, { changes: [] });
    const cur = encodeCursor({ v: 1, phase: "drain", changePage: "tokABC" });
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), cur),
    ).rejects.toThrow(/missing newStartPageToken after drain/);
  });
});

describe("google-drive-sync — phase machine: delta", () => {
  test("delta page with nextPageToken → cursor preserves pageToken and increments deltaPage", async () => {
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, {
      changes: [],
      nextPageToken: "delta-page-2",
    });
    const cur = encodeCursor({ v: 1, phase: "delta", pageToken: "d1" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), cur);
    expect(res.hasMore).toBe(true);
    if (res.cursor === null) {
      throw new Error("cursor null");
    }
    const decoded = JSON.parse(
      Buffer.from(res.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({
      v: 1,
      phase: "delta",
      pageToken: "delta-page-2",
      deltaPage: 1,
    });
  });

  test("DELTA_PAGE_LIMIT exceeded (deltaPage >= 10_000) → throws to prevent infinite loop", async () => {
    const cur = encodeCursor({ v: 1, phase: "delta", pageToken: "x", deltaPage: 10_000 });
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), cur),
    ).rejects.toThrow(/exceeded page limit/);
    expect(fixture.fetchMock.calls).toHaveLength(0);
  });
});
