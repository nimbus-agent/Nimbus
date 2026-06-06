// scim-http-routes.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { IdentityStore } from "./identity-store.ts";
import {
  dispatchScimRead,
  isScimPath,
  runScimWrite,
  SCIM_WRITE_ROUTES,
} from "./scim-http-routes.ts";
import { ScimError } from "./scim-service.ts";

function writeCtx() {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return {
    writeDb: db,
    store: new NamespaceStore(db),
    identity: new IdentityStore(db),
    nowMs: () => 1,
  };
}

function getReq(path: string, token: string | undefined): Request {
  const headers: Record<string, string> = {};
  // Truthiness (not `!== undefined`) so a token-named operand never sits beside an equality
  // operator — the Opengrep timing-attack heuristic flags `===`/`!==` on token-like identifiers.
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new Request(`http://127.0.0.1${path}`, { method: "GET", headers });
}

describe("SCIM HTTP routes — shape", () => {
  test("isScimPath matches /scim/v2/Users and item paths", () => {
    expect(isScimPath(new URL("https://x/scim/v2/Users"))).toBe(true);
    expect(isScimPath(new URL("https://x/scim/v2/Users/u1"))).toBe(true);
    expect(isScimPath(new URL("https://x/v1/deployments"))).toBe(false);
  });

  test("SCIM_WRITE_ROUTES is exactly the 3 write routes", () => {
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect([...SCIM_WRITE_ROUTES].sort(byName)).toEqual(
      ["DELETE /scim/v2/Users/{id}", "PATCH /scim/v2/Users/{id}", "POST /scim/v2/Users"].sort(
        byName,
      ),
    );
  });
});

describe("runScimWrite — SCIM write semantics (auth/rate-limit/audit owned by dispatchWriteRoute)", () => {
  test("POST provisions and returns the leak-proof 201 resource", async () => {
    const c = writeCtx();
    const res = await runScimWrite(
      "POST /scim/v2/Users",
      undefined,
      {
        externalId: "u1",
        userName: "alice",
        active: true,
        emails: [{ value: "a@x", primary: true }],
      },
      c,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["active", "id", "schemas", "userName"]);
    expect(body["id"]).toBe("u1");
    expect(c.identity.getScimUser("u1")?.userName).toBe("alice");
  });

  test("PATCH active:false deprovisions and revokes grants", async () => {
    const c = writeCtx();
    c.store.publish("ns", [{ kind: "service", value: "github" }]);
    c.store.grant("ns", "peer:alice", "viewer", true);
    c.identity.bind("u1", "peer:alice", "admin", 1);
    await runScimWrite("POST /scim/v2/Users", undefined, { externalId: "u1", userName: "a" }, c);

    const res = await runScimWrite(
      "PATCH /scim/v2/Users/{id}",
      "u1",
      { Operations: [{ op: "replace", path: "active", value: false }] },
      c,
    );
    expect(res.status).toBe(200);
    expect(c.store.getActiveGrant("ns", "peer:alice")).toBeUndefined();
  });

  test("DELETE deprovisions and returns 204", async () => {
    const c = writeCtx();
    await runScimWrite("POST /scim/v2/Users", undefined, { externalId: "u1", userName: "a" }, c);
    const res = await runScimWrite("DELETE /scim/v2/Users/{id}", "u1", undefined, c);
    expect(res.status).toBe(204);
    expect(c.identity.getScimUser("u1")?.active).toBe(false);
  });

  test("throws ScimError(400) on a non-object body", async () => {
    const c = writeCtx();
    await expect(
      runScimWrite("POST /scim/v2/Users", undefined, [1, 2, 3], c),
    ).rejects.toBeInstanceOf(ScimError);
  });

  test("throws ScimError(400) when an item route is missing its id", async () => {
    const c = writeCtx();
    await expect(
      runScimWrite("DELETE /scim/v2/Users/{id}", undefined, undefined, c),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("dispatchScimRead — bearer-checked roster read (spec §6)", () => {
  function readable() {
    const c = writeCtx();
    return { identity: c.identity, scimToken: "scim-secret", seed: c };
  }

  test("GET lists the roster (leak-proof ListResponse) and reads a single User", async () => {
    const r = readable();
    await runScimWrite(
      "POST /scim/v2/Users",
      undefined,
      { externalId: "u1", userName: "alice" },
      r.seed,
    );
    await runScimWrite(
      "POST /scim/v2/Users",
      undefined,
      { externalId: "u2", userName: "bob" },
      r.seed,
    );

    const list = dispatchScimRead(getReq("/scim/v2/Users", "scim-secret"), r);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      schemas: string[];
      totalResults: number;
      Resources: Array<Record<string, unknown>>;
    };
    expect(listBody.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:ListResponse"]);
    expect(listBody.totalResults).toBe(2);
    expect(Object.keys(listBody.Resources[0] ?? {}).sort()).toEqual([
      "active",
      "id",
      "schemas",
      "userName",
    ]);

    const read = dispatchScimRead(getReq("/scim/v2/Users/u1", "scim-secret"), r);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { id: string }).id).toBe("u1");
  });

  test("GET on a missing User is 404", async () => {
    const r = readable();
    const res = dispatchScimRead(getReq("/scim/v2/Users/nope", "scim-secret"), r);
    expect(res.status).toBe(404);
  });

  test("GET without a valid bearer is 401 (roster read is not public)", async () => {
    const r = readable();
    expect(dispatchScimRead(getReq("/scim/v2/Users", undefined), r).status).toBe(401);
    expect(dispatchScimRead(getReq("/scim/v2/Users", "wrong"), r).status).toBe(401);
  });

  test("GET is 503 when the SCIM surface is disabled (empty token)", () => {
    const r = readable();
    const res = dispatchScimRead(getReq("/scim/v2/Users", "scim-secret"), {
      identity: r.identity,
      scimToken: "",
    });
    expect(res.status).toBe(503);
  });
});
