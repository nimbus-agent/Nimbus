import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { JwksCache } from "./jwks-cache.ts";

function jwksResponse(kid: string): Response {
  return new Response(
    JSON.stringify({ keys: [{ kid, kty: "RSA", n: "AAAA", e: "AQAB", alg: "RS256" }] }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}
function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return db;
}

describe("JwksCache", () => {
  test("fetches + persists on a kid miss, then serves from cache", async () => {
    const db = freshDb();
    let calls = 0;
    const fetchLike = async () => {
      calls++;
      return jwksResponse("k1");
    };
    const cache = new JwksCache(db, fetchLike, { maxAgeSeconds: 3600 });
    const first = await cache.getKey("https://acme", "https://acme/jwks", "k1", 1000);
    expect(first?.kid).toBe("k1");
    expect(calls).toBe(1);
    const second = await cache.getKey("https://acme", "https://acme/jwks", "k1", 2000);
    expect(second?.kid).toBe("k1");
    expect(calls).toBe(1); // served from cache
  });

  test("kid miss with offline fetch returns undefined (fail closed)", async () => {
    const db = freshDb();
    const fetchLike = async () => {
      throw new Error("offline");
    };
    const cache = new JwksCache(db, fetchLike, { maxAgeSeconds: 3600 });
    expect(
      await cache.getKey("https://acme", "https://acme/jwks", "missing", 1000),
    ).toBeUndefined();
  });

  test("stale-past-TTL key is refetched; if offline it is NOT served", async () => {
    const db = freshDb();
    let online = true;
    const fetchLike = async () => {
      if (!online) throw new Error("offline");
      return jwksResponse("k1");
    };
    const cache = new JwksCache(db, fetchLike, { maxAgeSeconds: 10 });
    await cache.getKey("https://acme", "https://acme/jwks", "k1", 0); // cached at t=0
    online = false;
    // now is 20_000ms later → key is older than 10s TTL → refetch attempted → offline → not served
    expect(await cache.getKey("https://acme", "https://acme/jwks", "k1", 20_000)).toBeUndefined();
  });
});
