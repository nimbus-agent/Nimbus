import { describe, expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { enrichPrDetail, selectPrEnrichCandidates } from "./github-sync.ts";

function seedPrRow(
  db: ReturnType<typeof createMemoryIndexDb>,
  repoFull: string,
  num: number,
  title: string,
  modifiedAt: number,
  extraMetadata: Record<string, unknown> = {},
): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: `${repoFull}#${String(num)}`,
    title,
    bodyPreview: "",
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata: { number: num, repo: repoFull, ...extraMetadata },
    syncedAt: modifiedAt,
  });
}

function ctxFor(db: ReturnType<typeof createMemoryIndexDb>): SyncContext {
  return syncTestContext(db, createStubVault({}), "github");
}

function titleOf(db: ReturnType<typeof createMemoryIndexDb>, externalId: string): string {
  const row = db.query("SELECT title FROM item WHERE external_id = ?").get(externalId) as {
    title: string;
  };
  return row.title;
}

describe("enrichPrDetail", () => {
  test("enriches only fallback-titled PRs, newest-first, capped at 10", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    seedPrRow(db, "acme/app", 1, "PR #1", 1000); // fallback -> enrich
    seedPrRow(db, "acme/app", 2, "Real title", 2000, { additions: 5, deletions: 2 }); // real title + stats -> skip
    const fetchImpl = ((): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify({ number: 1, title: "Fix the retry loop", html_url: "https://x/pr/1" }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;

    const n = await enrichPrDetail(ctx, "pat", 3000, fetchImpl);

    expect(n).toBe(1);
    expect(titleOf(db, "acme/app#1")).toBe("Fix the retry loop");
    expect(titleOf(db, "acme/app#2")).toBe("Real title");
  });

  test("a failed detail fetch leaves the fallback untouched", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    seedPrRow(db, "acme/app", 9, "PR #9", 1000);
    const fetchImpl = (() =>
      Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch;

    const n = await enrichPrDetail(ctx, "pat", 2000, fetchImpl);

    expect(n).toBe(0);
    expect(titleOf(db, "acme/app#9")).toBe("PR #9");
  });

  test("returns 0 when there are no PRs needing enrichment", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    seedPrRow(db, "acme/app", 3, "Add retry backoff", 1000, { additions: 5, deletions: 2 });
    const fetchImpl = (() =>
      Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;

    const n = await enrichPrDetail(ctx, "pat", 2000, fetchImpl);

    expect(n).toBe(0);
  });

  test("caps at 10 and processes newest-first", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    for (let i = 1; i <= 12; i += 1) {
      seedPrRow(db, "acme/app", i, `PR #${String(i)}`, i * 1000);
    }
    const fetched: number[] = [];
    const fetchImpl = ((url: string) => {
      const match = /\/pulls\/(\d+)$/.exec(url);
      const num = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
      fetched.push(num);
      return Promise.resolve(
        new Response(JSON.stringify({ number: num, title: `Real ${String(num)}` }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;

    const n = await enrichPrDetail(ctx, "pat", 20000, fetchImpl);

    expect(n).toBe(10);
    expect(fetched).toHaveLength(10);
    // newest-first: PR #12 down to PR #3 (modified_at DESC), #1 and #2 left for next tick.
    expect(fetched).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(titleOf(db, "acme/app#1")).toBe("PR #1");
    expect(titleOf(db, "acme/app#2")).toBe("PR #2");
  });

  test("a 401 response throws UnauthenticatedError", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    seedPrRow(db, "acme/app", 5, "PR #5", 1000);
    const fetchImpl = (() =>
      Promise.resolve(new Response("nope", { status: 401 }))) as unknown as typeof fetch;

    await expect(enrichPrDetail(ctx, "pat", 2000, fetchImpl)).rejects.toThrow(/unauthorized/);
  });

  test("a rate-limited (403, no remaining) response propagates and aborts the tick", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    seedPrRow(db, "acme/app", 6, "PR #6", 1000);
    seedPrRow(db, "acme/app", 7, "PR #7", 2000);
    const fetchImpl = (() =>
      Promise.resolve(
        new Response("nope", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      )) as unknown as typeof fetch;

    await expect(enrichPrDetail(ctx, "pat", 3000, fetchImpl)).rejects.toThrow(/rate limited/);
    expect(titleOf(db, "acme/app#7")).toBe("PR #7");
  });

  // Note: `selectPrEnrichCandidates` over-selects via `title LIKE 'PR #%'` and then narrows
  // in JS with an exact-match check (`isExactFallback` — see that function's docstring): a
  // title merely starting with "PR #" (e.g. "PR #142 fix bug") that already has stats is
  // filtered back out, while a title that IS the exact fallback ("PR #<num>") stays a
  // candidate regardless of stats, so its real title still gets fetched. This fixture's
  // title ("Revert of PR #1") does not start with "PR #" at all, so it never collides with
  // the LIKE prefix in the first place — it verifies the plain case: a real title with stats
  // already captured is left untouched.
  test("a real title with stats already captured is not clobbered", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    seedPrRow(db, "acme/app", 1, "Revert of PR #1", 1000, { additions: 5, deletions: 2 });
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ number: 1, title: "Fix the retry loop" }), {
          status: 200,
        }),
      )) as unknown as typeof fetch;

    const n = await enrichPrDetail(ctx, "pat", 2000, fetchImpl);

    expect(n).toBe(0);
    expect(titleOf(db, "acme/app#1")).toBe("Revert of PR #1");
  });

  test("a malformed JSON response is skipped, not enriched", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    seedPrRow(db, "acme/app", 8, "PR #8", 1000);
    const fetchImpl = (() =>
      Promise.resolve(new Response("not json", { status: 200 }))) as unknown as typeof fetch;

    const n = await enrichPrDetail(ctx, "pat", 2000, fetchImpl);

    expect(n).toBe(0);
    expect(titleOf(db, "acme/app#8")).toBe("PR #8");
  });

  test("valid JSON that is not an object (e.g. an array) is skipped, not enriched", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    seedPrRow(db, "acme/app", 10, "PR #10", 1000);
    const fetchImpl = (() =>
      Promise.resolve(new Response("[1,2,3]", { status: 200 }))) as unknown as typeof fetch;

    const n = await enrichPrDetail(ctx, "pat", 2000, fetchImpl);

    expect(n).toBe(0);
    expect(titleOf(db, "acme/app#10")).toBe("PR #10");
  });
});

describe("selectPrEnrichCandidates", () => {
  test("a PR with a real title but no stats is selected for enrichment", () => {
    const db = createMemoryIndexDb();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title: "Add rate limiter", // NOT the `PR #1` fallback
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      metadata: { repo: "acme/app", number: 1 }, // no additions/deletions
    });

    const candidates = selectPrEnrichCandidates(db, 10);
    expect(candidates.map((c) => c.externalId)).toEqual(["acme/app#1"]);
    db.close();
  });

  test("a PR with stats already captured is not selected", () => {
    const db = createMemoryIndexDb();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title: "Add rate limiter",
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      metadata: { repo: "acme/app", number: 1, additions: 120, deletions: 30 },
    });

    expect(selectPrEnrichCandidates(db, 10)).toEqual([]);
    db.close();
  });

  test("a real title that merely starts with the fallback prefix is NOT re-selected once it has stats (prevents permanent re-enrichment)", () => {
    const db = createMemoryIndexDb();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title: "PR #1 revert", // starts with the fallback prefix but is a real title
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      metadata: { repo: "acme/app", number: 1, additions: 5, deletions: 2 },
    });

    expect(selectPrEnrichCandidates(db, 10)).toEqual([]);
    db.close();
  });

  test("a fallback-titled PR is still selected even with stats", () => {
    const db = createMemoryIndexDb();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#2",
      title: "PR #2",
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      metadata: { repo: "acme/app", number: 2, additions: 1, deletions: 1 },
    });

    expect(selectPrEnrichCandidates(db, 10).map((c) => c.externalId)).toEqual(["acme/app#2"]);
    db.close();
  });

  test("a row with malformed metadata does not throw and the good row is still returned", () => {
    const db = createMemoryIndexDb();
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title: "Add rate limiter", // NOT the `PR #1` fallback, no stats -> genuine candidate
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      metadata: { repo: "acme/app", number: 1 },
    });
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#2",
      title: "Fine already",
      bodyPreview: "",
      modifiedAt: now + 1,
      syncedAt: now,
      metadata: { repo: "acme/app", number: 2 },
    });
    // Plant deliberately malformed JSON directly — the normal write path always
    // JSON-stringifies, so this can only be reproduced via a raw UPDATE.
    db.run("UPDATE item SET metadata = ? WHERE external_id = ?", ["{bad", "acme/app#2"]);

    let candidates: ReturnType<typeof selectPrEnrichCandidates> | undefined;
    expect(() => {
      candidates = selectPrEnrichCandidates(db, 10);
    }).not.toThrow();
    expect(candidates?.map((c) => c.externalId)).toContain("acme/app#1");
    db.close();
  });

  test("selectPrEnrichCandidates never returns more than the limit", () => {
    const db = createMemoryIndexDb();
    const now = Date.now();
    for (let i = 1; i <= 15; i += 1) {
      upsertIndexedItem(db, {
        service: "github",
        type: "pr",
        externalId: `acme/app#${String(i)}`,
        title: `PR title ${String(i)}`,
        bodyPreview: "",
        modifiedAt: now + i,
        syncedAt: now,
        metadata: { repo: "acme/app", number: i },
      });
    }

    expect(selectPrEnrichCandidates(db, 10)).toHaveLength(10);
    db.close();
  });
});
