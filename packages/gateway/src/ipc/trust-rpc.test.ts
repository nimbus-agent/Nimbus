import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { TRUST_FEED_NAME } from "../extensions/trust/trust-feed.ts";
import type { TrustFeedHandle } from "../extensions/trust/trust-feed-boot.ts";
import { recordFeedAccepted } from "../extensions/trust/trust-store.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchTrustRpc } from "./trust-rpc.ts";

const ROOT = "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=";
const DAY = 86_400_000;

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
});
afterEach(() => db.close());

function handle(over: Partial<TrustFeedHandle> = {}): TrustFeedHandle {
  return {
    config: { url: "https://trust.example/", rootKey: ROOT },
    intervalHours: 1,
    refreshNow: () => Promise.resolve({ status: "unchanged", sequence: 3 }),
    ...over,
  };
}

describe("trust.status", () => {
  test("with no feed handle (a demo root, or a test): not configured, no floor", async () => {
    const out = await dispatchTrustRpc({
      method: "trust.status",
      db,
      trustFeed: undefined,
      now: () => 0,
    });
    expect(out).toEqual({
      kind: "hit",
      value: {
        configured: false,
        url: null,
        rootFingerprint: null,
        sequence: null,
        lastFetchedAt: null,
        lastAttemptedAt: null,
        ageDays: null,
        intervalHours: null,
        counts: { revocations: 0, takedowns: 0, rotations: 0, verifiedPublishers: 0, bySource: {} },
      },
    });
  });

  test("a build with no feed baked reports configured: false with its interval", async () => {
    const out = await dispatchTrustRpc({
      method: "trust.status",
      db,
      trustFeed: handle({ config: null }),
      now: () => 0,
    });
    expect(out).toMatchObject({ value: { configured: false, url: null, intervalHours: 1 } });
  });

  test("a configured feed reports its fingerprint, sequence and age in whole days", async () => {
    recordFeedAccepted(db, TRUST_FEED_NAME, {
      rootKey: ROOT,
      sequence: 12,
      documentSha256: "h",
      generatedAt: "2026-10-26T00:00:00Z",
      now: 1_000,
    });
    const out = await dispatchTrustRpc({
      method: "trust.status",
      db,
      trustFeed: handle(),
      now: () => 1_000 + 8 * DAY + 5,
    });
    expect(out).toMatchObject({
      value: {
        configured: true,
        url: "https://trust.example/",
        rootFingerprint: publisherKeyFingerprint(ROOT),
        sequence: 12,
        lastFetchedAt: 1_000,
        ageDays: 8,
      },
    });
  });
});

describe("trust.refresh", () => {
  test("routes to the handle's refresh", async () => {
    let calls = 0;
    const out = await dispatchTrustRpc({
      method: "trust.refresh",
      db,
      trustFeed: handle({
        refreshNow: () => {
          calls++;
          return Promise.resolve({ status: "not_configured" });
        },
      }),
      now: () => 0,
    });
    expect(out).toEqual({ kind: "hit", value: { status: "not_configured" } });
    expect(calls).toBe(1);
  });

  test("with no handle answers not_configured", async () => {
    expect(
      await dispatchTrustRpc({ method: "trust.refresh", db, trustFeed: undefined, now: () => 0 }),
    ).toEqual({ kind: "hit", value: { status: "not_configured" } });
  });

  test("an unknown trust method misses", async () => {
    expect(
      await dispatchTrustRpc({ method: "trust.nope", db, trustFeed: undefined, now: () => 0 }),
    ).toEqual({ kind: "miss" });
  });
});
