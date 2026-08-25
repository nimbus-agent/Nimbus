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

const START_TOKEN_PREFIX = "https://www.googleapis.com/drive/v3/changes/startPageToken?";
const FILES_LIST_PREFIX = "https://www.googleapis.com/drive/v3/files?";
const CHANGES_LIST_PREFIX = "https://www.googleapis.com/drive/v3/changes?";
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
    await expect(syncable.sync(fixture.createSyncContext("google_drive"), null)).rejects.toThrow(
      /refresh failed/,
    );
    expect(fixture.fetchMock.calls).toHaveLength(0);
  });

  test("token getter returns empty string → request fires with empty Bearer (no short-circuit)", async () => {
    tokenState.value = "";
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, { files: [] });
    const syncable = createGoogleDriveSyncable(ENSURE_MCP);
    await syncable.sync(fixture.createSyncContext("google_drive"), null);
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
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    expect(res.hasMore).toBe(true);
    expect(res.cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from((res.cursor ?? "").slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({ v: 1, phase: "drain", changePage: "t0" });
  });

  test("empty string cursor → same as null cursor (initial flow)", async () => {
    stageNullCursorFlowEmpty();
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      "",
    );
    expect(res.hasMore).toBe(true);
    expect(fixture.fetchMock.calls).toHaveLength(2);
    expect(fixture.fetchMock.calls[0]?.url).toMatch(START_TOKEN_RE);
    expect(fixture.fetchMock.calls[1]?.url).toMatch(FILES_LIST_RE);
  });

  test("wrong-prefix cursor → legacy migration path (treated as literal page token)", async () => {
    stageLegacyFlowEmpty();
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      "legacyOpaqueToken",
    );
    expect(res.hasMore).toBe(true);
    const filesCalls = fixture.fetchMock.calls.filter((c) => c.url.startsWith(FILES_LIST_PREFIX));
    expect(filesCalls).toHaveLength(1);
    expect(filesCalls[0]?.url).toContain("pageToken=legacyOpaqueToken");
  });

  test("non-base64 prefixed cursor → throws 'corrupt cursor'", async () => {
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("google_drive"),
        `${CURSOR_PREFIX}!!!not-base64!!!`,
      ),
    ).rejects.toThrow(/corrupt cursor/);
    expect(fixture.fetchMock.calls).toHaveLength(0);
  });

  test("prefixed cursor decoding to array → throws 'corrupt cursor'", async () => {
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("google_drive"),
        encodeCursor([1, 2, 3]),
      ),
    ).rejects.toThrow(/corrupt cursor/);
  });

  test("init_list cursor with missing t0 → throws 'corrupt cursor'", async () => {
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("google_drive"),
        encodeCursor({ v: 1, phase: "init_list", listToken: "abc" }),
      ),
    ).rejects.toThrow(/corrupt cursor/);
  });

  test("drain cursor with missing changePage → throws 'corrupt cursor'", async () => {
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("google_drive"),
        encodeCursor({ v: 1, phase: "drain" }),
      ),
    ).rejects.toThrow(/corrupt cursor/);
  });

  test("delta cursor with missing pageToken → throws 'corrupt cursor'", async () => {
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("google_drive"),
        encodeCursor({ v: 1, phase: "delta" }),
      ),
    ).rejects.toThrow(/corrupt cursor/);
  });

  test("prefixed cursor with unknown phase → throws 'corrupt cursor'", async () => {
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("google_drive"),
        encodeCursor({ v: 1, phase: "other", t0: "x" }),
      ),
    ).rejects.toThrow(/corrupt cursor/);
  });
});

describe("google-drive-sync — HTTP request paths", () => {
  test("sends Authorization: Bearer <token> header on startPageToken", async () => {
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, { files: [] });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const startCall = fixture.fetchMock.calls.find((c) => c.url.startsWith(START_TOKEN_PREFIX));
    expect(startCall).toBeDefined();
    expect(startCall?.headers["authorization"]).toBe("Bearer google-drive-stub-token");
  });

  test("sends Bearer header on files.list and includes q + pageSize=100 + fields", async () => {
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, { files: [] });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const filesCall = fixture.fetchMock.calls.find((c) => c.url.startsWith(FILES_LIST_PREFIX));
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
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      drainCursor,
    );
    const changesCall = fixture.fetchMock.calls.find((c) => c.url.startsWith(CHANGES_LIST_PREFIX));
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
      createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext("google_drive"), null),
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
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
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
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
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
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
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
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
    expect(res.itemsDeleted).toBe(0);
  });
});

describe("google-drive-sync — phase machine: init_list", () => {
  test("init_list cursor with listToken refetches files.list, no startPageToken call", async () => {
    fixture.fetchMock.respond("GET", FILES_LIST_RE, { files: [] });
    const cur = encodeCursor({ v: 1, phase: "init_list", t0: "tokA", listToken: "page2" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
    expect(res.hasMore).toBe(true);
    expect(
      fixture.fetchMock.calls.filter((c) => c.url.startsWith(START_TOKEN_PREFIX)),
    ).toHaveLength(0);
    const filesCalls = fixture.fetchMock.calls.filter((c) => c.url.startsWith(FILES_LIST_PREFIX));
    expect(filesCalls).toHaveLength(1);
    expect(filesCalls[0]?.url).toContain("pageToken=page2");
  });

  test("init_list page with nextPageToken → cursor preserves listToken (still in init_list)", async () => {
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [],
      nextPageToken: "page3",
    });
    const cur = encodeCursor({ v: 1, phase: "init_list", t0: "tokA", listToken: "page2" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
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
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
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
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
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
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
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
      createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext("google_drive"), cur),
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
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
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
      createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext("google_drive"), cur),
    ).rejects.toThrow(/exceeded page limit/);
    expect(fixture.fetchMock.calls).toHaveLength(0);
  });
});

// ─── Additional branch-coverage tests (B6) ──────────────────────────────────

describe("google-drive-sync — cursor decode extra branches (L79, L109)", () => {
  test("init_list cursor with listToken as a number → throws 'corrupt cursor' (L79 non-null non-string branch)", async () => {
    // L79: listToken !== null && typeof listToken !== "string" → return undefined → corrupt cursor
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("google_drive"),
        encodeCursor({ v: 1, phase: "init_list", t0: "abc", listToken: 42 }),
      ),
    ).rejects.toThrow(/corrupt cursor/);
  });

  test("cursor with v=2 → throws 'corrupt cursor' (L109 v !== 1 branch)", async () => {
    // L109: r["v"] !== 1 → return undefined → corrupt cursor
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("google_drive"),
        encodeCursor({ v: 2, phase: "init_list", t0: "abc", listToken: null }),
      ),
    ).rejects.toThrow(/corrupt cursor/);
  });

  test("init_list cursor with null listToken → passes through as null listToken (L459)", async () => {
    // L459: v1.listToken ?? undefined → listToken is null → undefined passed to listFilesPage (no pageToken param)
    fixture.fetchMock.respond("GET", FILES_LIST_RE, { files: [] });
    const cur = encodeCursor({ v: 1, phase: "init_list", t0: "tokA", listToken: null });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
    expect(res.hasMore).toBe(true);
    const filesCalls = fixture.fetchMock.calls.filter((c) => c.url.startsWith(FILES_LIST_PREFIX));
    expect(filesCalls).toHaveLength(1);
    // null listToken → no pageToken param in URL
    expect(filesCalls[0]?.url).not.toContain("pageToken=");
  });
});

describe("google-drive-sync — owner/email resolution branches (L133-L149)", () => {
  test("file with empty owners array → no author_id (L133 owners.length === 0)", async () => {
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [{ id: "f1", name: "file.txt", owners: [] }],
    });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const row = fixture.db
      .query<{ author_id: unknown }, []>(
        "SELECT author_id FROM item WHERE service = 'google_drive' AND external_id = 'f1'",
      )
      .get();
    expect(row).toBeDefined();
    expect(row?.author_id).toBeNull();
  });

  test("file with owner missing emailAddress → no author_id (L141/L144 email === undefined)", async () => {
    // emailAddress absent → email = undefined → L144 return null
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [{ id: "f2", name: "file.txt", owners: [{ displayName: "Alice" }] }],
    });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const row = fixture.db
      .query<{ author_id: unknown }, []>(
        "SELECT author_id FROM item WHERE service = 'google_drive' AND external_id = 'f2'",
      )
      .get();
    expect(row).toBeDefined();
    expect(row?.author_id).toBeNull();
  });

  test("file with owner empty emailAddress → no author_id (L141 emailAddress === '' branch)", async () => {
    // emailAddress is "" → treated as undefined → email = undefined → null returned
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [{ id: "f3", name: "file.txt", owners: [{ emailAddress: "", displayName: "Bob" }] }],
    });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const row = fixture.db
      .query<{ author_id: unknown }, []>(
        "SELECT author_id FROM item WHERE service = 'google_drive' AND external_id = 'f3'",
      )
      .get();
    expect(row).toBeDefined();
    expect(row?.author_id).toBeNull();
  });

  test("file with owner email only (no displayName) → ownerName falls back to email (L143/L149)", async () => {
    // displayName absent → ownerName = undefined → L149 ownerName ?? email = email used as displayName
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [{ id: "f4", name: "file.txt", owners: [{ emailAddress: "owner@example.com" }] }],
    });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const row = fixture.db
      .query<{ author_id: unknown }, []>(
        "SELECT author_id FROM item WHERE service = 'google_drive' AND external_id = 'f4'",
      )
      .get();
    expect(row).toBeDefined();
    expect(row?.author_id).not.toBeNull();
  });

  test("file with owner email + displayName → both fields used (L143 truthy branch, L149 ownerName used)", async () => {
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [
        {
          id: "f5",
          name: "file.txt",
          owners: [{ emailAddress: "owner@example.com", displayName: "Owner Person" }],
        },
      ],
    });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const row = fixture.db
      .query<{ author_id: unknown }, []>(
        "SELECT author_id FROM item WHERE service = 'google_drive' AND external_id = 'f5'",
      )
      .get();
    expect(row).toBeDefined();
    expect(row?.author_id).not.toBeNull();
  });
});

describe("google-drive-sync — upsertDriveFile field branches (L159, L163, L165-L169)", () => {
  test("trashed file via changes.list file.trashed (not removed=true) → delete (L207)", async () => {
    // L207: file.trashed === true in applyChange → deleteItemByServiceExternal
    fixture.db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, 'google_drive', 'file', 'trashed-via-file', 'x', 'x', null, null, 1, null, '{}', 1, 0)`,
      [itemPrimaryKey("google_drive", "trashed-via-file")],
    );
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, {
      changes: [{ file: { id: "trashed-via-file", name: "x.txt", trashed: true } }],
      newStartPageToken: "next-tok",
    });
    const cur = encodeCursor({ v: 1, phase: "drain", changePage: "tokX" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
    expect(res.itemsDeleted).toBe(1);
    const row = fixture.db
      .query("SELECT id FROM item WHERE id = ?")
      .get(itemPrimaryKey("google_drive", "trashed-via-file"));
    expect(row).toBeNull();
  });

  test("change with no file and removed=false → skip (L200 file === undefined)", async () => {
    // L200: file === undefined → return "skip"
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, {
      changes: [{ removed: false }],
      newStartPageToken: "next-tok",
    });
    const cur = encodeCursor({ v: 1, phase: "drain", changePage: "tokY" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
    expect(res.itemsDeleted).toBe(0);
    expect(res.itemsUpserted).toBe(0);
  });

  test("change file with empty id → skip (L204 id === '')", async () => {
    // L204: id === "" → return "skip"
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, {
      changes: [{ file: { id: "", name: "x.txt" } }],
      newStartPageToken: "next-tok",
    });
    const cur = encodeCursor({ v: 1, phase: "drain", changePage: "tokZ" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.itemsDeleted).toBe(0);
  });

  test("change file with missing id → skip (L204 id === undefined)", async () => {
    // L204: id === undefined → return "skip"
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, {
      changes: [{ file: { name: "x.txt" } }],
      newStartPageToken: "next-tok",
    });
    const cur = encodeCursor({ v: 1, phase: "drain", changePage: "tokW" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.itemsDeleted).toBe(0);
  });

  test("trashed file in files.list is skipped during init_list (L416 trashed guard)", async () => {
    // L416 init_list loop guards `f.trashed !== true`, so a trashed file in files.list is never indexed.
    // (upsertDriveFile's own L159 trashed arm is unreachable from this path — applyChange L207 short-circuits
    //  trashed changes before calling upsertDriveFile — so it is a D-candidate, not covered here.)
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [
        { id: "trashed-init", name: "deleted.txt", trashed: true },
        { id: "live-init", name: "live.txt" },
      ],
    });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    // trashed file skipped → only live-init upserted
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query(
        "SELECT external_id FROM item WHERE service = 'google_drive' AND external_id = 'trashed-init'",
      )
      .get();
    expect(row).toBeNull();
  });

  test("file missing mimeType → defaults to '' (not folder) (L163)", async () => {
    // L163: f.mimeType ?? "" → "" → isFolder = false
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [{ id: "no-mime", name: "file-no-mime.txt" }],
    });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const row = fixture.db
      .query<{ type: string }, []>(
        "SELECT type FROM item WHERE service = 'google_drive' AND external_id = 'no-mime'",
      )
      .get();
    expect(row?.type).toBe("file");
  });

  test("file missing modifiedTime → uses now as modifiedAt (L165)", async () => {
    // L165: f.modifiedTime === undefined → now used directly
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [{ id: "no-modtime", name: "no-modtime.txt" }],
    });
    const before = Date.now();
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const after = Date.now();
    const row = fixture.db
      .query<{ modified_at: number }, []>(
        "SELECT modified_at FROM item WHERE service = 'google_drive' AND external_id = 'no-modtime'",
      )
      .get();
    expect(row).toBeDefined();
    expect(row?.modified_at).toBeGreaterThanOrEqual(before);
    expect(row?.modified_at).toBeLessThanOrEqual(after);
  });

  test("file with invalid modifiedTime string → falls back to now (L166 !Number.isFinite)", async () => {
    // L166: Number.isFinite(modifiedMs) = false (NaN from Date.parse("not-a-date")) → safeModified = now
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [{ id: "bad-date", name: "bad-date.txt", modifiedTime: "not-a-date" }],
    });
    const before = Date.now();
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const after = Date.now();
    const row = fixture.db
      .query<{ modified_at: number }, []>(
        "SELECT modified_at FROM item WHERE service = 'google_drive' AND external_id = 'bad-date'",
      )
      .get();
    expect(row).toBeDefined();
    expect(row?.modified_at).toBeGreaterThanOrEqual(before);
    expect(row?.modified_at).toBeLessThanOrEqual(after);
  });

  test("file with description set → description used as bodyPreview (L168 desc !== '' branch)", async () => {
    // L168: desc === "" ? name : desc → desc path
    const desc = "This is my file description";
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [{ id: "with-desc", name: "file.txt", description: desc }],
    });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const row = fixture.db
      .query<{ body_preview: string }, []>(
        "SELECT body_preview FROM item WHERE service = 'google_drive' AND external_id = 'with-desc'",
      )
      .get();
    expect(row?.body_preview).toBe(desc);
  });

  test("file with description > 512 chars → bodyPreview truncated to 512 (L169)", async () => {
    // L169: previewBase.length > 512 → slice(0, 512)
    const longDesc = "x".repeat(600);
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [{ id: "long-desc", name: "file.txt", description: longDesc }],
    });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const row = fixture.db
      .query<{ body_preview: string }, []>(
        "SELECT body_preview FROM item WHERE service = 'google_drive' AND external_id = 'long-desc'",
      )
      .get();
    expect(row?.body_preview).toHaveLength(512);
  });

  test("file webViewLink set → url and canonicalUrl populated", async () => {
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "t0" });
    fixture.fetchMock.respond("GET", FILES_LIST_RE, {
      files: [
        {
          id: "with-link",
          name: "file.txt",
          webViewLink: "https://drive.google.com/file/d/123/view",
        },
      ],
    });
    await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      null,
    );
    const row = fixture.db
      .query<{ url: string }, []>(
        "SELECT url FROM item WHERE service = 'google_drive' AND external_id = 'with-link'",
      )
      .get();
    expect(row?.url).toBe("https://drive.google.com/file/d/123/view");
  });
});

describe("google-drive-sync — getStartPageToken missing token (L247)", () => {
  test("startPageToken response missing token field → throws (L247)", async () => {
    // L247: typeof t !== "string" || t === "" → throw "missing startPageToken"
    fixture.fetchMock.respond("GET", START_TOKEN_RE, {});
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext("google_drive"), null),
    ).rejects.toThrow(/missing startPageToken/);
  });

  test("startPageToken response has empty string token → throws (L247 t === '')", async () => {
    fixture.fetchMock.respond("GET", START_TOKEN_RE, { startPageToken: "" });
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext("google_drive"), null),
    ).rejects.toThrow(/missing startPageToken/);
  });
});

describe("google-drive-sync — runDriveChangePage nextPageToken branch (L316)", () => {
  test("delta page with nextPageToken → hasMore=true with new delta cursor (L316)", async () => {
    // L316: next !== undefined && next !== "" → return hasMore=true with buildNextCursor(next)
    // (delta phase, different from drain to get independent test for L316 delta path)
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, {
      changes: [],
      nextPageToken: "more-changes",
    });
    const cur = encodeCursor({ v: 1, phase: "delta", pageToken: "tok1", deltaPage: 0 });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
    expect(res.hasMore).toBe(true);
    if (res.cursor === null) {
      throw new Error("cursor null");
    }
    const decoded = JSON.parse(
      Buffer.from(res.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    // buildNextCursor for delta: { v:1, phase:"delta", pageToken: next, deltaPage: currentDeltaPage }
    expect(decoded.phase).toBe("delta");
    expect(decoded.pageToken).toBe("more-changes");
    expect(decoded.deltaPage).toBe(1);
  });

  test("delta page finalizes with newStartPageToken (L316 else branch) → hasMore=false", async () => {
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, {
      changes: [],
      newStartPageToken: "final-tok",
    });
    const cur = encodeCursor({ v: 1, phase: "delta", pageToken: "tok2" });
    const res = await createGoogleDriveSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("google_drive"),
      cur,
    );
    expect(res.hasMore).toBe(false);
    if (res.cursor === null) {
      throw new Error("cursor null");
    }
    const decoded = JSON.parse(
      Buffer.from(res.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({ v: 1, phase: "delta", pageToken: "final-tok" });
  });

  test("delta page missing newStartPageToken → throws (delta missingNewTokenMessage)", async () => {
    fixture.fetchMock.respond("GET", CHANGES_LIST_RE, { changes: [] });
    const cur = encodeCursor({ v: 1, phase: "delta", pageToken: "tok3" });
    await expect(
      createGoogleDriveSyncable(ENSURE_MCP).sync(fixture.createSyncContext("google_drive"), cur),
    ).rejects.toThrow(/missing newStartPageToken/);
  });
});
