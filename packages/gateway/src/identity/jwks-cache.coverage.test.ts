import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { JwksCache } from "./jwks-cache.ts";
import type { FetchLike } from "./types.ts";

/**
 * Every way a JWKS answer can be unusable, and what the cache does with each. The contract under
 * test is the cache's own fail-CLOSED rule: an IdP that answers with something other than a
 * well-formed key set yields `undefined` and caches nothing, malformed entries inside a valid set
 * are skipped rather than half-stored, and a corrupt cached row is never served. Rows are asserted
 * directly, so "nothing was persisted" is checked, not assumed.
 */

const ISSUER = "https://acme";
const JWKS_URI = "https://acme/jwks";
const NOW = 1_000_000;

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function freshDb(): Database {
  const db = new Database(":memory:");
  dbs.push(db);
  runIndexedSchemaMigrations(db, 34);
  return db;
}

function cachedKids(db: Database): string[] {
  return (
    db.query("SELECT kid FROM oidc_jwks_cache WHERE issuer = ? ORDER BY kid").all(ISSUER) as Array<{
      kid: string;
    }>
  ).map((r) => r.kid);
}

/** A fetch answering every call with `make()`, counting the calls. */
function answering(make: () => Response): { fetchLike: FetchLike; calls: () => number } {
  let n = 0;
  return {
    fetchLike: async () => {
      n += 1;
      return make();
    },
    calls: () => n,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const RSA_K1 = { kid: "k1", kty: "RSA", n: "AAAA", e: "AQAB", alg: "RS256" };

describe("JwksCache — unusable IdP answers fail closed", () => {
  test("a non-2xx JWKS response yields undefined and persists nothing", async () => {
    const db = freshDb();
    const f = answering(() => json({ keys: [RSA_K1] }, 503));
    const cache = new JwksCache(db, f.fetchLike, { maxAgeSeconds: 3600 });

    expect(await cache.getKey(ISSUER, JWKS_URI, "k1", NOW)).toBeUndefined();
    expect(f.calls()).toBe(1);
    expect(cachedKids(db)).toEqual([]);
  });

  test("a 200 whose body is not JSON yields undefined", async () => {
    const db = freshDb();
    const f = answering(() => new Response("<html>gateway timeout</html>", { status: 200 }));
    const cache = new JwksCache(db, f.fetchLike, { maxAgeSeconds: 3600 });

    expect(await cache.getKey(ISSUER, JWKS_URI, "k1", NOW)).toBeUndefined();
    expect(cachedKids(db)).toEqual([]);
  });

  test("a JSON body that is null, or a primitive, yields undefined", async () => {
    for (const body of [null, 42, "keys"]) {
      const db = freshDb();
      const cache = new JwksCache(db, answering(() => json(body)).fetchLike, {
        maxAgeSeconds: 3600,
      });
      expect(await cache.getKey(ISSUER, JWKS_URI, "k1", NOW)).toBeUndefined();
      expect(cachedKids(db)).toEqual([]);
    }
  });

  test("a body whose keys member is not an array yields undefined", async () => {
    const db = freshDb();
    const cache = new JwksCache(db, answering(() => json({ keys: { k1: RSA_K1 } })).fetchLike, {
      maxAgeSeconds: 3600,
    });

    expect(await cache.getKey(ISSUER, JWKS_URI, "k1", NOW)).toBeUndefined();
    expect(cachedKids(db)).toEqual([]);
  });
});

describe("JwksCache — malformed entries inside a valid key set", () => {
  test("null, primitive and kid-less entries are skipped; well-formed siblings are cached", async () => {
    const db = freshDb();
    const keys = [
      null,
      "not-a-key",
      { kty: "RSA", n: "BBBB", e: "AQAB" },
      { kid: 7, kty: "RSA" },
      RSA_K1,
      { kid: "k2", kty: "RSA", n: "CCCC", e: "AQAB" },
    ];
    const cache = new JwksCache(db, answering(() => json({ keys })).fetchLike, {
      maxAgeSeconds: 3600,
    });

    const got = await cache.getKey(ISSUER, JWKS_URI, "k1", NOW);
    expect(got).toEqual(RSA_K1);
    expect(cachedKids(db)).toEqual(["k1", "k2"]);
  });

  test("a valid key set that lacks the requested kid yields undefined after caching what it has", async () => {
    const db = freshDb();
    const cache = new JwksCache(db, answering(() => json({ keys: [RSA_K1] })).fetchLike, {
      maxAgeSeconds: 3600,
    });

    expect(await cache.getKey(ISSUER, JWKS_URI, "rotated-away", NOW)).toBeUndefined();
    expect(cachedKids(db)).toEqual(["k1"]);
  });
});

describe("JwksCache — a corrupt cached row is never served", () => {
  function seedCorrupt(db: Database): void {
    db.run("INSERT INTO oidc_jwks_cache (issuer, kid, key_json, fetched_at) VALUES (?, ?, ?, ?)", [
      ISSUER,
      "k1",
      "{not json",
      NOW,
    ]);
  }

  test("a fresh-but-unparseable row forces a refetch that overwrites it", async () => {
    const db = freshDb();
    seedCorrupt(db);
    const f = answering(() => json({ keys: [RSA_K1] }));
    const cache = new JwksCache(db, f.fetchLike, { maxAgeSeconds: 3600 });

    expect(await cache.getKey(ISSUER, JWKS_URI, "k1", NOW + 1)).toEqual(RSA_K1);
    expect(f.calls()).toBe(1);
    const row = db
      .query("SELECT key_json, fetched_at FROM oidc_jwks_cache WHERE issuer = ? AND kid = ?")
      .get(ISSUER, "k1") as { key_json: string; fetched_at: number };
    expect(JSON.parse(row.key_json)).toEqual(RSA_K1);
    expect(row.fetched_at).toBe(NOW + 1);
  });

  test("a fresh-but-unparseable row with the IdP offline fails closed", async () => {
    const db = freshDb();
    seedCorrupt(db);
    const cache = new JwksCache(
      db,
      async () => {
        throw new Error("offline");
      },
      { maxAgeSeconds: 3600 },
    );

    expect(await cache.getKey(ISSUER, JWKS_URI, "k1", NOW + 1)).toBeUndefined();
  });
});
