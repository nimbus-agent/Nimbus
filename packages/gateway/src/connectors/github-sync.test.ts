import { describe, expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { enrichFallbackPrTitles } from "./github-sync.ts";

function seedPrRow(
  db: ReturnType<typeof createMemoryIndexDb>,
  repoFull: string,
  num: number,
  title: string,
  modifiedAt: number,
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
    metadata: { number: num, repo: repoFull },
    syncedAt: modifiedAt,
  });
}

function ctxFor(db: ReturnType<typeof createMemoryIndexDb>): SyncContext {
  return syncTestContext(db, createStubVault({}));
}

function titleOf(db: ReturnType<typeof createMemoryIndexDb>, externalId: string): string {
  const row = db.query("SELECT title FROM item WHERE external_id = ?").get(externalId) as {
    title: string;
  };
  return row.title;
}

describe("enrichFallbackPrTitles", () => {
  test("enriches only fallback-titled PRs, newest-first, capped at 10", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    seedPrRow(db, "acme/app", 1, "PR #1", 1000); // fallback -> enrich
    seedPrRow(db, "acme/app", 2, "Real title", 2000); // not fallback -> skip
    const fetchImpl = ((): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify({ number: 1, title: "Fix the retry loop", html_url: "https://x/pr/1" }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;

    const n = await enrichFallbackPrTitles(ctx, "pat", 3000, fetchImpl);

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

    const n = await enrichFallbackPrTitles(ctx, "pat", 2000, fetchImpl);

    expect(n).toBe(0);
    expect(titleOf(db, "acme/app#9")).toBe("PR #9");
  });

  test("returns 0 when there are no fallback-titled rows", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    seedPrRow(db, "acme/app", 3, "Add retry backoff", 1000);
    const fetchImpl = (() =>
      Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;

    const n = await enrichFallbackPrTitles(ctx, "pat", 2000, fetchImpl);

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

    const n = await enrichFallbackPrTitles(ctx, "pat", 20000, fetchImpl);

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

    await expect(enrichFallbackPrTitles(ctx, "pat", 2000, fetchImpl)).rejects.toThrow(
      /unauthorized/,
    );
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

    await expect(enrichFallbackPrTitles(ctx, "pat", 3000, fetchImpl)).rejects.toThrow(
      /rate limited/,
    );
    expect(titleOf(db, "acme/app#7")).toBe("PR #7");
  });

  test("a malformed JSON response is skipped, not enriched", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    seedPrRow(db, "acme/app", 8, "PR #8", 1000);
    const fetchImpl = (() =>
      Promise.resolve(new Response("not json", { status: 200 }))) as unknown as typeof fetch;

    const n = await enrichFallbackPrTitles(ctx, "pat", 2000, fetchImpl);

    expect(n).toBe(0);
    expect(titleOf(db, "acme/app#8")).toBe("PR #8");
  });
});
