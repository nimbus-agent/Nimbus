import { expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  syncTestContext,
} from "../../connector-sync-test-helpers.ts";
import { normalisedApiBase, syncGitlabEventsPages, webOriginFromApiBase } from "./events.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("webOriginFromApiBase — strips /api/v4 suffix", () => {
  expect(webOriginFromApiBase("https://gitlab.example.com/api/v4")).toBe(
    "https://gitlab.example.com",
  );
});

test("webOriginFromApiBase — strips trailing slash then /api/v4", () => {
  // stripTrailingSlashes runs first, then the endsWith check
  expect(webOriginFromApiBase("https://gitlab.example.com/api/v4/")).toBe(
    "https://gitlab.example.com",
  );
});

test("webOriginFromApiBase — falls back to https://gitlab.com when no /api/v4", () => {
  expect(webOriginFromApiBase("https://gitlab.example.com/other")).toBe("https://gitlab.com");
});

test("webOriginFromApiBase — falls back to https://gitlab.com for arbitrary string", () => {
  expect(webOriginFromApiBase("https://gitlab.com")).toBe("https://gitlab.com");
});

test("normalisedApiBase — returns default for null", () => {
  expect(normalisedApiBase(null)).toBe("https://gitlab.com/api/v4");
});

test("normalisedApiBase — returns default for empty string", () => {
  expect(normalisedApiBase("")).toBe("https://gitlab.com/api/v4");
});

test("normalisedApiBase — returns default for whitespace-only string", () => {
  expect(normalisedApiBase("   ")).toBe("https://gitlab.com/api/v4");
});

test("normalisedApiBase — strips trailing slash from non-empty value", () => {
  expect(normalisedApiBase("https://gitlab.example.com/api/v4/")).toBe(
    "https://gitlab.example.com/api/v4",
  );
});

test("normalisedApiBase — returns value as-is when no trailing slash", () => {
  expect(normalisedApiBase("https://gitlab.example.com/api/v4")).toBe(
    "https://gitlab.example.com/api/v4",
  );
});

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/** Build a GitLab events API response */
function makeEventsResponse(items: unknown[], headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Minimal valid MergeRequest event */
function makeMrEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    target_type: "MergeRequest",
    target_iid: 42,
    target_title: "Fix the bug",
    action_name: "opened",
    created_at: new Date(now - 3600_000).toISOString(),
    author_username: "alice",
    author_name: "Alice",
    project: { path_with_namespace: "group/my-project" },
    ...overrides,
  };
}

/** Minimal valid Issue event */
function makeIssueEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    target_type: "Issue",
    target_iid: 7,
    target_title: "Track this",
    action_name: "created",
    created_at: new Date(now - 1800_000).toISOString(),
    author_username: "bob",
    author_name: "Bob",
    project: { path_with_namespace: "group/my-project" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// syncGitlabEventsPages — happy paths
// ---------------------------------------------------------------------------

describeWithFetchRestore("syncGitlabEventsPages — MergeRequest event", () => {
  test("upserts a MergeRequest event into the DB", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({});
    const ctx = syncTestContext(db, vault, "gitlab");

    const event = makeMrEvent();
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    const now = Date.now();
    const floorAfter = new Date(now - 86400_000).toISOString();
    const result = await syncGitlabEventsPages(
      ctx,
      "pat-token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      floorAfter,
      1,
      performance.now(),
    );

    expect(result.itemsUpserted).toBe(1);
    expect(result.hasMore).toBe(false);
    expectServiceItemCount(db, "gitlab", 1);
    const row = db
      .prepare("SELECT type, external_id FROM item WHERE service = 'gitlab' LIMIT 1")
      .get() as { type: string; external_id: string } | undefined;
    expect(row?.type).toBe("pr");
    expect(row?.external_id).toContain("!42");
  });
});

describeWithFetchRestore("syncGitlabEventsPages — Issue event", () => {
  test("upserts an Issue event into the DB", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    const event = makeIssueEvent();
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    const now = Date.now();
    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "gitlab", 1);
    const row = db
      .prepare("SELECT type, external_id FROM item WHERE service = 'gitlab' LIMIT 1")
      .get() as { type: string; external_id: string } | undefined;
    expect(row?.type).toBe("issue");
    expect(row?.external_id).toContain("#7");
  });
});

// ---------------------------------------------------------------------------
// processEvent — branches
// ---------------------------------------------------------------------------

describeWithFetchRestore("processEvent — unknown targetType is skipped", () => {
  test("event with unknown target_type is not upserted", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const event = makeMrEvent({ target_type: "Commit" }); // not MergeRequest or Issue
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "gitlab", 0);
  });
});

describeWithFetchRestore("processEvent — missing project field is skipped", () => {
  test("event without project field is not upserted", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const event = makeMrEvent({ project: undefined });
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.itemsUpserted).toBe(0);
  });
});

describeWithFetchRestore("processEvent — project is a non-object primitive", () => {
  test("event where project is a string (asRecord returns undefined) is skipped", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const event = makeMrEvent({ project: "not-an-object" });
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.itemsUpserted).toBe(0);
  });
});

describeWithFetchRestore("processEvent — missing target_iid is skipped", () => {
  test("event without target_iid is not upserted", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    // target_iid must be a number — set to undefined
    const { target_iid: _removed, ...rest } = makeMrEvent();
    const event = { ...rest };
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.itemsUpserted).toBe(0);
  });
});

describeWithFetchRestore("processEvent — empty path_with_namespace is skipped", () => {
  test("event with empty path_with_namespace is not upserted", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const event = makeMrEvent({ project: { path_with_namespace: "" } });
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.itemsUpserted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// upsertFromMergeRequestEvent — author branches
// ---------------------------------------------------------------------------

describeWithFetchRestore("MR event — author_username absent → null authorId", () => {
  test("MR without author_username resolves to null authorId", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const event = makeMrEvent({ author_username: undefined, author_name: undefined });
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT author_id FROM item WHERE service = 'gitlab' LIMIT 1").get() as
      | { author_id: string | null }
      | undefined;
    expect(row?.author_id).toBeNull();
  });
});

describeWithFetchRestore("MR event — empty author_username → null authorId", () => {
  test("MR with empty-string author_username resolves to null authorId", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const event = makeMrEvent({ author_username: "" });
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    const row = db.prepare("SELECT author_id FROM item WHERE service = 'gitlab' LIMIT 1").get() as
      | { author_id: string | null }
      | undefined;
    expect(row?.author_id).toBeNull();
  });
});

describeWithFetchRestore(
  "MR event — author_name undefined → falls back to username for displayName",
  () => {
    test("MR with author_username but no author_name uses username as displayName", async () => {
      const db = createMemoryIndexDb();
      const ctx = syncTestContext(db, createStubVault({}), "gitlab");
      const now = Date.now();

      const event = makeMrEvent({ author_username: "charlie", author_name: undefined });
      globalThis.fetch = (() =>
        Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

      const result = await syncGitlabEventsPages(
        ctx,
        "token",
        "https://gitlab.com/api/v4",
        "https://gitlab.com",
        new Date(now - 86400_000).toISOString(),
        1,
        performance.now(),
      );

      expect(result.itemsUpserted).toBe(1);
      const row = db.prepare("SELECT author_id FROM item WHERE service = 'gitlab' LIMIT 1").get() as
        | { author_id: string | null }
        | undefined;
      // author_id should be resolved (not null) because username is present
      expect(row?.author_id).not.toBeNull();
    });
  },
);

// ---------------------------------------------------------------------------
// upsertFromMergeRequestEvent — title truncation
// ---------------------------------------------------------------------------

describeWithFetchRestore("MR event — title longer than 512 chars is truncated", () => {
  test("title > 512 characters is truncated to 512", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const longTitle = "A".repeat(600);
    const event = makeMrEvent({ target_title: longTitle });
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    const row = db.prepare("SELECT title FROM item WHERE service = 'gitlab' LIMIT 1").get() as
      | { title: string }
      | undefined;
    expect(row?.title).toHaveLength(512);
  });
});

// ---------------------------------------------------------------------------
// upsertFromMergeRequestEvent — modifiedAt fallback
// ---------------------------------------------------------------------------

describeWithFetchRestore("MR event — invalid created_at falls back to now", () => {
  test("MR with unparseable created_at uses current time as modifiedAt", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const t0 = Date.now();

    const event = makeMrEvent({ created_at: "not-a-date" });
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(t0 - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    const row = db.prepare("SELECT modified_at FROM item WHERE service = 'gitlab' LIMIT 1").get() as
      | { modified_at: number }
      | undefined;
    // modified_at should be roughly "now", not a parsed date
    expect(row?.modified_at).toBeGreaterThanOrEqual(t0 - 1000);
  });
});

// ---------------------------------------------------------------------------
// upsertFromIssueEvent — title truncation + author branches
// ---------------------------------------------------------------------------

describeWithFetchRestore("Issue event — title longer than 512 chars is truncated", () => {
  test("Issue title > 512 chars is truncated to 512", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const longTitle = "B".repeat(700);
    const event = makeIssueEvent({ target_title: longTitle });
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    const row = db.prepare("SELECT title FROM item WHERE service = 'gitlab' LIMIT 1").get() as
      | { title: string }
      | undefined;
    expect(row?.title).toHaveLength(512);
  });
});

describeWithFetchRestore("Issue event — author_username absent → null authorId", () => {
  test("Issue without author_username resolves to null authorId", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const event = makeIssueEvent({ author_username: undefined });
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT author_id FROM item WHERE service = 'gitlab' LIMIT 1").get() as
      | { author_id: string | null }
      | undefined;
    expect(row?.author_id).toBeNull();
  });
});

describeWithFetchRestore("Issue event — invalid created_at falls back to now", () => {
  test("Issue with unparseable created_at uses current time as modifiedAt", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const t0 = Date.now();

    const event = makeIssueEvent({ created_at: "bad-date" });
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(t0 - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    const row = db.prepare("SELECT modified_at FROM item WHERE service = 'gitlab' LIMIT 1").get() as
      | { modified_at: number }
      | undefined;
    expect(row?.modified_at).toBeGreaterThanOrEqual(t0 - 1000);
  });
});

// ---------------------------------------------------------------------------
// processEvent — optional fields absent (title, action_name, created_at)
// ---------------------------------------------------------------------------

describeWithFetchRestore("processEvent — target_title absent → falls back to '(no title)'", () => {
  test("MR event without target_title gets title '(no title)'", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const { target_title: _removed, ...rest } = makeMrEvent();
    const event = { ...rest };
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    const row = db.prepare("SELECT title FROM item WHERE service = 'gitlab' LIMIT 1").get() as
      | { title: string }
      | undefined;
    expect(row?.title).toBe("(no title)");
  });
});

describeWithFetchRestore("processEvent — created_at absent → uses generated ISO string", () => {
  test("MR event without created_at uses now-based ISO for modified_at", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const t0 = Date.now();

    const { created_at: _removed, ...rest } = makeMrEvent();
    const event = { ...rest };
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(t0 - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    const row = db.prepare("SELECT modified_at FROM item WHERE service = 'gitlab' LIMIT 1").get() as
      | { modified_at: number }
      | undefined;
    // modified_at should be within a few seconds of now
    expect(row?.modified_at).toBeGreaterThanOrEqual(t0 - 5000);
  });
});

// ---------------------------------------------------------------------------
// gitlabApplyEventsPage — non-record item is skipped
// ---------------------------------------------------------------------------

describeWithFetchRestore("gitlabApplyEventsPage — non-record array items are skipped", () => {
  test("array items that are not objects are skipped (asRecord returns undefined)", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    // mix: one primitive, one valid event
    const items = ["not-an-object", 42, makeMrEvent()];
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse(items))) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.itemsUpserted).toBe(1);
  });
});

describeWithFetchRestore("gitlabApplyEventsPage — created_at advances newestIso", () => {
  test("newestIso advances when event created_at is newer than floor", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const newerDate = new Date(now - 600_000).toISOString(); // 10 min ago
    const event = makeMrEvent({ created_at: newerDate });
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    const floorAfter = new Date(now - 86400_000).toISOString(); // 1 day ago
    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      floorAfter,
      1,
      performance.now(),
    );

    // cursor should advance to the event's created_at
    expect(result.cursorAfter).toBe(newerDate);
    expect(result.hasMore).toBe(false);
  });
});

describeWithFetchRestore(
  "gitlabApplyEventsPage — older created_at does not update newestIso",
  () => {
    test("newestIso stays at floor when all events are older", async () => {
      const db = createMemoryIndexDb();
      const ctx = syncTestContext(db, createStubVault({}), "gitlab");
      const now = Date.now();

      // floor is recent; event is older than the floor
      const floor = new Date(now - 3600_000).toISOString(); // 1 hour ago
      const olderThanFloor = new Date(now - 7200_000).toISOString(); // 2 hours ago
      const event = makeIssueEvent({ created_at: olderThanFloor });
      globalThis.fetch = (() =>
        Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

      const result = await syncGitlabEventsPages(
        ctx,
        "token",
        "https://gitlab.com/api/v4",
        "https://gitlab.com",
        floor,
        1,
        performance.now(),
      );

      // cursorAfter stays at the floor since no event was newer
      expect(result.cursorAfter).toBe(floor);
    });
  },
);

// ---------------------------------------------------------------------------
// gitlabFetchEventsPage — error paths
// ---------------------------------------------------------------------------

describeWithFetchRestore("gitlabFetchEventsPage — 429 throws and penalises", () => {
  test("429 response throws with message containing '429'", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("Rate limited", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
      )) as unknown as typeof fetch;

    await expect(
      syncGitlabEventsPages(
        ctx,
        "token",
        "https://gitlab.com/api/v4",
        "https://gitlab.com",
        new Date(now - 86400_000).toISOString(),
        1,
        performance.now(),
      ),
    ).rejects.toThrow("429");
  });
});

describeWithFetchRestore(
  "gitlabFetchEventsPage — 429 with no retry-after header uses default 60s",
  () => {
    test("429 without retry-after header still throws", async () => {
      const db = createMemoryIndexDb();
      const ctx = syncTestContext(db, createStubVault({}), "gitlab");
      const now = Date.now();

      // No retry-after header → ra === null → sec defaults to 60
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response("Too many requests", { status: 429 }),
        )) as unknown as typeof fetch;

      await expect(
        syncGitlabEventsPages(
          ctx,
          "token",
          "https://gitlab.com/api/v4",
          "https://gitlab.com",
          new Date(now - 86400_000).toISOString(),
          1,
          performance.now(),
        ),
      ).rejects.toThrow("429");
    });
  },
);

describeWithFetchRestore(
  "gitlabFetchEventsPage — 429 with non-numeric retry-after uses 60s",
  () => {
    test("429 with non-numeric retry-after still throws", async () => {
      const db = createMemoryIndexDb();
      const ctx = syncTestContext(db, createStubVault({}), "gitlab");
      const now = Date.now();

      // retry-after = "abc" → parseInt returns NaN → isFinite(NaN) false → 60_000
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "abc" },
          }),
        )) as unknown as typeof fetch;

      await expect(
        syncGitlabEventsPages(
          ctx,
          "token",
          "https://gitlab.com/api/v4",
          "https://gitlab.com",
          new Date(now - 86400_000).toISOString(),
          1,
          performance.now(),
        ),
      ).rejects.toThrow("429");
    });
  },
);

describeWithFetchRestore("gitlabFetchEventsPage — non-ok (500) throws", () => {
  test("500 response throws with status in message", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("Internal Server Error", { status: 500 }),
      )) as unknown as typeof fetch;

    await expect(
      syncGitlabEventsPages(
        ctx,
        "token",
        "https://gitlab.com/api/v4",
        "https://gitlab.com",
        new Date(now - 86400_000).toISOString(),
        1,
        performance.now(),
      ),
    ).rejects.toThrow("500");
  });
});

describeWithFetchRestore("gitlabFetchEventsPage — invalid JSON throws", () => {
  test("non-JSON body throws 'GitLab events: invalid JSON'", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("not json {{", { status: 200 }))) as unknown as typeof fetch;

    await expect(
      syncGitlabEventsPages(
        ctx,
        "token",
        "https://gitlab.com/api/v4",
        "https://gitlab.com",
        new Date(now - 86400_000).toISOString(),
        1,
        performance.now(),
      ),
    ).rejects.toThrow("invalid JSON");
  });
});

describeWithFetchRestore("gitlabFetchEventsPage — non-array JSON throws", () => {
  test("JSON object body throws 'GitLab events: expected array'", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ not: "an array" }), { status: 200 }),
      )) as unknown as typeof fetch;

    await expect(
      syncGitlabEventsPages(
        ctx,
        "token",
        "https://gitlab.com/api/v4",
        "https://gitlab.com",
        new Date(now - 86400_000).toISOString(),
        1,
        performance.now(),
      ),
    ).rejects.toThrow("expected array");
  });
});

// ---------------------------------------------------------------------------
// gitlabShouldContinuePaging — branches
// ---------------------------------------------------------------------------

describeWithFetchRestore("gitlabShouldContinuePaging — no x-next-page header stops paging", () => {
  test("response without x-next-page header → hasMore false, single page", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([makeMrEvent()]))) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.hasMore).toBe(false);
    expect(result.cursorPage).toBe(1);
  });
});

describeWithFetchRestore(
  "gitlabShouldContinuePaging — empty x-next-page header stops paging",
  () => {
    test("response with empty x-next-page header → hasMore false", async () => {
      const db = createMemoryIndexDb();
      const ctx = syncTestContext(db, createStubVault({}), "gitlab");
      const now = Date.now();

      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify([makeMrEvent()]), {
            status: 200,
            headers: { "x-next-page": "" },
          }),
        )) as unknown as typeof fetch;

      const result = await syncGitlabEventsPages(
        ctx,
        "token",
        "https://gitlab.com/api/v4",
        "https://gitlab.com",
        new Date(now - 86400_000).toISOString(),
        1,
        performance.now(),
      );

      expect(result.hasMore).toBe(false);
    });
  },
);

describeWithFetchRestore(
  "gitlabShouldContinuePaging — x-next-page same as current page stops paging",
  () => {
    test("x-next-page equals current page number → hasMore false", async () => {
      const db = createMemoryIndexDb();
      const ctx = syncTestContext(db, createStubVault({}), "gitlab");
      const now = Date.now();

      // x-next-page = "1" (same as startPage=1) → nextPageRaw !== String(page) is false
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify([makeMrEvent()]), {
            status: 200,
            headers: { "x-next-page": "1" },
          }),
        )) as unknown as typeof fetch;

      const result = await syncGitlabEventsPages(
        ctx,
        "token",
        "https://gitlab.com/api/v4",
        "https://gitlab.com",
        new Date(now - 86400_000).toISOString(),
        1,
        performance.now(),
      );

      expect(result.hasMore).toBe(false);
    });
  },
);

describeWithFetchRestore("gitlabShouldContinuePaging — empty items array stops paging", () => {
  test("empty items array with x-next-page header → hasMore false", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    // itemCount = 0 → hasNext is false even with a valid x-next-page
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "x-next-page": "2" },
        }),
      )) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.hasMore).toBe(false);
  });
});

describeWithFetchRestore(
  "gitlabShouldContinuePaging — non-numeric x-next-page stops paging",
  () => {
    test("x-next-page 'abc' → parseInt returns NaN → stops paging", async () => {
      const db = createMemoryIndexDb();
      const ctx = syncTestContext(db, createStubVault({}), "gitlab");
      const now = Date.now();

      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify([makeMrEvent()]), {
            status: 200,
            headers: { "x-next-page": "abc" },
          }),
        )) as unknown as typeof fetch;

      const result = await syncGitlabEventsPages(
        ctx,
        "token",
        "https://gitlab.com/api/v4",
        "https://gitlab.com",
        new Date(now - 86400_000).toISOString(),
        1,
        performance.now(),
      );

      expect(result.hasMore).toBe(false);
    });
  },
);

describeWithFetchRestore("gitlabShouldContinuePaging — x-next-page zero stops paging", () => {
  test("x-next-page = '0' (np <= 0) → stops paging", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([makeMrEvent()]), {
          status: 200,
          headers: { "x-next-page": "0" },
        }),
      )) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// syncGitlabEventsPages — multi-page pagination
// ---------------------------------------------------------------------------

describeWithFetchRestore("syncGitlabEventsPages — multi-page: follows x-next-page", () => {
  test("follows x-next-page through two pages then stops", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    let callCount = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify([makeMrEvent(), makeIssueEvent()]), {
          status: 200,
          headers: { "x-next-page": "2" },
        });
      }
      // Page 2: no next page header
      return new Response(JSON.stringify([makeMrEvent({ target_iid: 99 })]), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(callCount).toBe(2);
    expect(result.itemsUpserted).toBe(3);
    expect(result.hasMore).toBe(false);
    expectServiceItemCount(db, "gitlab", 3);
  });
});

describeWithFetchRestore("syncGitlabEventsPages — MAX_PAGES_PER_SYNC cap → hasMore true", () => {
  test("stops with hasMore=true after MAX_PAGES_PER_SYNC (8) pages", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    let callCount = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      callCount += 1;
      // Always return a next page → forces MAX_PAGES_PER_SYNC cap
      const nextPage = callCount + 1;
      return new Response(JSON.stringify([makeMrEvent({ target_iid: callCount })]), {
        status: 200,
        headers: { "x-next-page": String(nextPage) },
      });
    }) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(callCount).toBe(8); // MAX_PAGES_PER_SYNC = 8
    expect(result.hasMore).toBe(true);
    expect(result.cursorPage).toBeGreaterThan(1);
    // cursorAfter is the original floorAfter when hasMore=true
    expect(result.cursorAfter).toBe(new Date(now - 86400_000).toISOString());
  });
});

describeWithFetchRestore("syncGitlabEventsPages — bytesTransferred accumulates", () => {
  test("bytesTransferred reflects total text length across pages", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const body = JSON.stringify([makeMrEvent()]);
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.bytesTransferred).toBe(body.length);
  });
});

describeWithFetchRestore("syncGitlabEventsPages — durationMs is non-negative", () => {
  test("durationMs is a non-negative number", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    globalThis.fetch = (() => Promise.resolve(makeEventsResponse([]))) as unknown as typeof fetch;

    const result = await syncGitlabEventsPages(
      ctx,
      "token",
      "https://gitlab.com/api/v4",
      "https://gitlab.com",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// URL construction — webOrigin is used in URLs
// ---------------------------------------------------------------------------

describeWithFetchRestore("upsertFromMergeRequestEvent — URL uses webOrigin", () => {
  test("MR item URL contains webOrigin and project path", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const event = makeMrEvent();
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    await syncGitlabEventsPages(
      ctx,
      "token",
      "https://mygitlab.example/api/v4",
      "https://mygitlab.example",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    const row = db.prepare("SELECT url FROM item WHERE service = 'gitlab' LIMIT 1").get() as
      | { url: string }
      | undefined;
    expect(row?.url).toContain("https://mygitlab.example");
    expect(row?.url).toContain("merge_requests/42");
  });
});

describeWithFetchRestore("upsertFromIssueEvent — URL uses webOrigin", () => {
  test("Issue item URL contains webOrigin and issue path", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");
    const now = Date.now();

    const event = makeIssueEvent();
    globalThis.fetch = (() =>
      Promise.resolve(makeEventsResponse([event]))) as unknown as typeof fetch;

    await syncGitlabEventsPages(
      ctx,
      "token",
      "https://mygitlab.example/api/v4",
      "https://mygitlab.example",
      new Date(now - 86400_000).toISOString(),
      1,
      performance.now(),
    );

    const row = db.prepare("SELECT url FROM item WHERE service = 'gitlab' LIMIT 1").get() as
      | { url: string }
      | undefined;
    expect(row?.url).toContain("https://mygitlab.example");
    expect(row?.url).toContain("issues/7");
  });
});
