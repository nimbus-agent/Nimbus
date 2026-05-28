import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { openSeededInMemoryDb } from "../../test/helpers/migrated-db-seed.ts";
import { HttpWriteRateLimiter } from "./http-rate-limit.ts";
import { dispatchWriteRoute, WRITE_ROUTE_ALLOWLIST } from "./http-write-routes.ts";

function freshContext(): {
  writeDb: Database;
  expectedToken: string;
  rateLimiter: HttpWriteRateLimiter;
  nowMs: () => number;
  knownServices: () => readonly string[];
} {
  const db = openSeededInMemoryDb(28);
  return {
    writeDb: db,
    expectedToken: "hunter2",
    rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    nowMs: () => 1_700_000_000_000,
    knownServices: () => ["payment-service"],
  };
}

describe("dispatchWriteRoute", () => {
  it("returns 405 + Allow: POST when a known write path is hit with the wrong method", async () => {
    const ctx = freshContext();
    const req = new Request("http://127.0.0.1/v1/deployments", { method: "GET" });
    const res = await dispatchWriteRoute(req, ctx);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("returns 404 for an unknown path", async () => {
    const ctx = freshContext();
    const req = new Request("http://127.0.0.1/v1/totally-unknown", { method: "POST" });
    const res = await dispatchWriteRoute(req, ctx);
    expect(res.status).toBe(404);
  });

  it("keeps the I13 allowlist count at 1 (POST /v1/deployments)", () => {
    expect(WRITE_ROUTE_ALLOWLIST.length).toBe(1);
    expect(WRITE_ROUTE_ALLOWLIST.includes("POST /v1/deployments")).toBe(true);
  });
});
