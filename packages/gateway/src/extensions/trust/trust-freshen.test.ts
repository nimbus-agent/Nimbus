import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { TrustFeedResult } from "./trust-feed.ts";
import { TRUST_FEED_NAME } from "./trust-feed.ts";
import { type FreshenHandle, freshenTrustFeed, trustFeedNote } from "./trust-freshen.ts";
import { recordFeedAccepted } from "./trust-store.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-26T12:00:00Z");
const CONFIG = { url: "https://trust.example/", rootKey: "k" };

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
});
afterEach(() => db.close());

function handle(answer: () => Promise<TrustFeedResult>): FreshenHandle & { calls: number } {
  const h = {
    config: CONFIG,
    calls: 0,
    refreshNow: () => {
      h.calls++;
      return answer();
    },
  };
  return h;
}

function floor(opts: { fetchedAt: number | null; generatedAt?: string }): void {
  recordFeedAccepted(db, TRUST_FEED_NAME, {
    rootKey: "k",
    sequence: 1,
    documentSha256: "h",
    generatedAt: opts.generatedAt ?? "2026-10-20T12:00:00Z",
    now: opts.fetchedAt ?? NOW,
    fetched: opts.fetchedAt !== null,
  });
}

describe("freshenTrustFeed", () => {
  test("no feed in this build, or no handle: not_configured, nothing fetched", async () => {
    expect(await freshenTrustFeed(undefined, db, NOW)).toEqual({
      status: "not_configured",
      ageDays: null,
    });
    const h = handle(() => Promise.resolve({ status: "not_configured" }));
    expect((await freshenTrustFeed({ ...h, config: null }, db, NOW)).status).toBe("not_configured");
    expect(h.calls).toBe(0);
  });

  test("a fetch under 5 minutes old is fresh and skips the request", async () => {
    floor({ fetchedAt: NOW - 60_000 });
    const h = handle(() => Promise.resolve({ status: "unchanged", sequence: 1 }));
    expect(await freshenTrustFeed(h, db, NOW)).toEqual({ status: "fresh", ageDays: 0 });
    expect(h.calls).toBe(0);
  });

  test("an older fetch refreshes; accepted or unchanged is refreshed", async () => {
    floor({ fetchedAt: NOW - DAY });
    const h = handle(() => Promise.resolve({ status: "unchanged", sequence: 1 }));
    expect(await freshenTrustFeed(h, db, NOW)).toEqual({ status: "refreshed", ageDays: 0 });
    expect(h.calls).toBe(1);
  });

  test("a refused refresh is stale with the stored age", async () => {
    floor({ fetchedAt: NOW - 3 * DAY });
    const h = handle(() =>
      Promise.resolve({ status: "refused", code: "ERR_REGISTRY_UNREACHABLE", detail: "down" }),
    );
    expect(await freshenTrustFeed(h, db, NOW)).toEqual({ status: "stale", ageDays: 3 });
  });

  test("a refresh that never settles is cut off at the cap", async () => {
    floor({ fetchedAt: NOW - 2 * DAY });
    const h = handle(() => new Promise<TrustFeedResult>(() => {}));
    expect(await freshenTrustFeed(h, db, NOW, { timeoutMs: 20 })).toEqual({
      status: "stale",
      ageDays: 2,
    });
  });

  test("only the snapshot ever applied: the age comes from its generatedAt", async () => {
    floor({ fetchedAt: null, generatedAt: "2026-10-16T12:00:00Z" });
    const h = handle(() => Promise.resolve({ status: "refused", code: "X", detail: "y" }));
    expect(await freshenTrustFeed(h, db, NOW)).toEqual({ status: "stale", ageDays: 10 });
  });

  test("no floor at all, or a throwing handle: stale with no age", async () => {
    const refused = handle(() => Promise.resolve({ status: "refused", code: "X", detail: "y" }));
    expect(await freshenTrustFeed(refused, db, NOW)).toEqual({ status: "stale", ageDays: null });
    const throwing = handle(() => {
      throw new Error("boom");
    });
    expect(await freshenTrustFeed(throwing, db, NOW)).toEqual({ status: "stale", ageDays: null });
  });
});

describe("trustFeedNote", () => {
  test("only a stale outcome produces a note; the age is said when known", () => {
    expect(trustFeedNote({ status: "fresh", ageDays: 0 })).toBeUndefined();
    expect(trustFeedNote({ status: "not_configured", ageDays: null })).toBeUndefined();
    expect(trustFeedNote({ status: "stale", ageDays: 1 })).toContain("last updated 1 day ago");
    expect(trustFeedNote({ status: "stale", ageDays: 4 })).toContain("4 days ago");
    expect(trustFeedNote({ status: "stale", ageDays: null })).toBe(
      "the trust feed could not be refreshed, so a revocation published since then may not have reached this machine",
    );
  });
});
