import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { openSeededInMemoryDb } from "../../test/helpers/migrated-db-seed.ts";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { IdentityStore } from "../identity/identity-store.ts";
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

  it("keeps the I13 allowlist at the deployment + 3 SCIM routes", () => {
    expect(WRITE_ROUTE_ALLOWLIST.length).toBe(4);
    expect([...WRITE_ROUTE_ALLOWLIST]).toEqual([
      "POST /v1/deployments",
      "POST /scim/v2/Users",
      "PATCH /scim/v2/Users/{id}",
      "DELETE /scim/v2/Users/{id}",
    ]);
  });
});

describe("dispatchWriteRoute — SCIM writes flow through the I13 pipeline", () => {
  function scimContext() {
    const db = openSeededInMemoryDb(34);
    return {
      writeDb: db,
      expectedToken: "deploy-token",
      rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
      nowMs: () => 1_700_000_000_000,
      knownServices: (): readonly string[] => [],
      scim: {
        token: "scim-secret",
        store: new NamespaceStore(db),
        identity: new IdentityStore(db),
      },
    };
  }
  function scimReq(
    method: string,
    path: string,
    token: string | undefined,
    body?: unknown,
  ): Request {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
    return new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  function auditCount(db: Database, actionType: string): number {
    const row = db
      .query("SELECT COUNT(*) AS n FROM audit_log WHERE action_type = ?")
      .get(actionType) as { n: number };
    return row.n;
  }

  it("provisions a user with a valid bearer (201) and surfaces rate-limit headers", async () => {
    const ctx = scimContext();
    const res = await dispatchWriteRoute(
      scimReq("POST", "/scim/v2/Users", "scim-secret", { externalId: "u1", userName: "alice" }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(ctx.scim.identity.getScimUser("u1")?.userName).toBe("alice");
  });

  it("rejects a bad SCIM bearer with 401 and writes a scim.provision_rejected audit row", async () => {
    const ctx = scimContext();
    const res = await dispatchWriteRoute(
      scimReq("POST", "/scim/v2/Users", "wrong", { externalId: "u1" }),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(auditCount(ctx.writeDb, "scim.provision_rejected")).toBe(1);
    expect(auditCount(ctx.writeDb, "deployment.annotation_rejected")).toBe(0);
  });

  it("returns 503 when the SCIM bearer is unset (surface disabled)", async () => {
    const ctx = { ...scimContext(), scim: { ...scimContext().scim, token: "" } };
    const res = await dispatchWriteRoute(
      scimReq("POST", "/scim/v2/Users", "scim-secret", { externalId: "u1" }),
      ctx,
    );
    expect(res.status).toBe(503);
  });

  it("404s a SCIM path when the SCIM surface is not wired", async () => {
    const { scim: _scim, ...noScim } = scimContext();
    const res = await dispatchWriteRoute(
      scimReq("POST", "/scim/v2/Users", "scim-secret", { externalId: "u1" }),
      noScim,
    );
    expect(res.status).toBe(404);
  });

  it("rate-limits SCIM writes per token (429 + audit)", async () => {
    const ctx = {
      ...scimContext(),
      rateLimiter: new HttpWriteRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    };
    const first = await dispatchWriteRoute(
      scimReq("POST", "/scim/v2/Users", "scim-secret", { externalId: "u1", userName: "a" }),
      ctx,
    );
    expect(first.status).toBe(201);
    const second = await dispatchWriteRoute(
      scimReq("POST", "/scim/v2/Users", "scim-secret", { externalId: "u2", userName: "b" }),
      ctx,
    );
    expect(second.status).toBe(429);
    expect(auditCount(ctx.writeDb, "scim.provision_rejected")).toBe(1);
  });

  it("PATCH with the deployment token (wrong surface) is 401, not accepted", async () => {
    const ctx = scimContext();
    await dispatchWriteRoute(
      scimReq("POST", "/scim/v2/Users", "scim-secret", { externalId: "u1", userName: "a" }),
      ctx,
    );
    const res = await dispatchWriteRoute(
      scimReq("PATCH", "/scim/v2/Users/u1", "deploy-token", {
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
      ctx,
    );
    expect(res.status).toBe(401);
  });
});
