// scim-http-routes.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { IdentityStore } from "./identity-store.ts";
import { dispatchScimRoute, isScimPath, SCIM_WRITE_ROUTES } from "./scim-http-routes.ts";

function ctx() {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return {
    writeDb: db,
    store: new NamespaceStore(db),
    identity: new IdentityStore(db),
    scimToken: "scim-secret",
    nowMs: () => 1,
  };
}
function req(method: string, path: string, token: string | undefined, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/scim+json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("SCIM HTTP routes", () => {
  test("isScimPath matches /scim/v2/Users and item paths", () => {
    expect(isScimPath(new URL("https://x/scim/v2/Users"))).toBe(true);
    expect(isScimPath(new URL("https://x/scim/v2/Users/u1"))).toBe(true);
    expect(isScimPath(new URL("https://x/v1/deployments"))).toBe(false);
  });

  test("allowlist is exactly the 3 SCIM write routes", () => {
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect([...SCIM_WRITE_ROUTES].sort(byName)).toEqual(
      ["DELETE /scim/v2/Users/{id}", "PATCH /scim/v2/Users/{id}", "POST /scim/v2/Users"].sort(
        byName,
      ),
    );
  });

  test("400 (not 500) on a malformed JSON body", async () => {
    const bad = new Request("http://127.0.0.1/scim/v2/Users", {
      method: "POST",
      headers: { "content-type": "application/scim+json", authorization: "Bearer scim-secret" },
      body: "{ not json",
    });
    const res = await dispatchScimRoute(bad, ctx());
    expect(res.status).toBe(400);
  });

  test("400 on a JSON array body (arrays are not SCIM resources)", async () => {
    const res = await dispatchScimRoute(
      req("POST", "/scim/v2/Users", "scim-secret", [1, 2, 3]),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  test("401 without a valid bearer", async () => {
    const res = await dispatchScimRoute(
      req("POST", "/scim/v2/Users", "wrong", { externalId: "u1", userName: "a" }),
      ctx(),
    );
    expect(res.status).toBe(401);
  });

  test("POST provisions, PATCH active:false deprovisions", async () => {
    const c = ctx();
    c.store.publish("ns", [{ kind: "service", value: "github" }]);
    c.store.grant("ns", "peer:alice", "viewer", true);
    c.identity.bind("u1", "peer:alice", "admin", 1);
    const create = await dispatchScimRoute(
      req("POST", "/scim/v2/Users", "scim-secret", {
        externalId: "u1",
        userName: "alice",
        active: true,
      }),
      c,
    );
    expect(create.status).toBe(201);
    const patch = await dispatchScimRoute(
      req("PATCH", "/scim/v2/Users/u1", "scim-secret", {
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
      c,
    );
    expect(patch.status).toBe(200);
    expect(c.store.getActiveGrant("ns", "peer:alice")).toBeUndefined();
  });
});
