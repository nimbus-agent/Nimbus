import type { Database } from "bun:sqlite";
import { describe, expect, it, test } from "bun:test";

import { openSeededInMemoryDb } from "../../test/helpers/migrated-db-seed.ts";
import type { AgentHttpInvoker } from "../agent-runs/agent-http-invoke.ts";
import { MAX_CONCURRENT_RUNS, MAX_SOURCE_BYTES } from "../briefs/brief-constants.ts";
import { BriefRunController, type CreateResult } from "../briefs/brief-run-store.ts";
import { ReportTooLargeError } from "../briefs/brief-save.ts";
import type { Report } from "../briefs/brief-types.ts";
import type { ApiScope } from "../clips/api-scopes.ts";
import { ClipValidationError } from "../clips/clip-ingest.ts";
import { PairingWindowController } from "../clips/pairing-window.ts";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { IdentityStore } from "../identity/identity-store.ts";
import { ScimError } from "../identity/scim-service.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import type { TargetedFetchOutcome } from "../sync/targeted-fetch.ts";
import { HttpWriteRateLimiter } from "./http-rate-limit.ts";
import type {
  BriefsWriteSurface,
  ClipsWriteSurface,
  WriteRouteContext,
} from "./http-write-routes.ts";
import {
  dispatchWriteRoute,
  ROUTE_ITEMS_FETCH,
  WRITE_ROUTE_ALLOWLIST,
} from "./http-write-routes.ts";

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

  it("teams-events: valid Bot Framework JWT → onActivity called, 200", async () => {
    const got: unknown[] = [];
    const ctx = {
      ...freshContext(),
      messaging: {
        teamsBotAppId: "app-123",
        validateBotJwt: async (h: string | null) => h === "Bearer good",
        onActivity: async (a: unknown) => {
          got.push(a);
        },
      },
    };
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/v1/messaging/teams/events", {
        method: "POST",
        headers: { authorization: "Bearer good", "content-type": "application/json" },
        body: JSON.stringify({ type: "message", text: "hi" }),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(got).toEqual([{ type: "message", text: "hi" }]);
  });

  it("teams-events: invalid JWT → 401, onActivity not called", async () => {
    const got: unknown[] = [];
    const ctx = {
      ...freshContext(),
      messaging: {
        teamsBotAppId: "app-123",
        validateBotJwt: async () => false,
        onActivity: async (a: unknown) => {
          got.push(a);
        },
      },
    };
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/v1/messaging/teams/events", {
        method: "POST",
        headers: { authorization: "Bearer bad", "content-type": "application/json" },
        body: JSON.stringify({ type: "message" }),
      }),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(got).toEqual([]);
  });

  it("teams-events: surface absent → 404", async () => {
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/v1/messaging/teams/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      freshContext(),
    );
    expect(res.status).toBe(404);
  });

  it("keeps the I13 allowlist at deployment + 3 SCIM + admin-policy + teams-events + 2 clip + 4 brief + 1 agent + 1 items-fetch route", () => {
    // I13: the write surface is closed by enumeration, and this assertion is the review gate on
    // widening it. `POST /v1/agents/{agent}` is the thirteenth: it invokes a read-only agent and
    // returns a run id to poll. It is a WRITE by classification — not because it mutates the index
    // (it does not), but because putting it here is what subjects it to the bearer gate, the
    // per-route body cap and the per-token rate limiter. Reclassifying it as a read to skip the
    // allowlist would be the exact evasion the allowlist exists to prevent. `POST /v1/items/fetch`
    // is the fourteenth: it DOES cause an outbound provider request and an index write, so — unlike
    // the agent route — it is a write for the ordinary reason too, and it is deliberately not
    // modeled as a read (that reclassification is exactly how a write slips past the allowlist).
    expect(WRITE_ROUTE_ALLOWLIST).toHaveLength(14);
    expect([...WRITE_ROUTE_ALLOWLIST]).toEqual([
      "POST /v1/deployments",
      "POST /scim/v2/Users",
      "PATCH /scim/v2/Users/{id}",
      "DELETE /scim/v2/Users/{id}",
      "PUT /v1/admin/policy",
      "POST /v1/messaging/teams/events",
      "POST /v1/clips",
      "POST /v1/clips/pair/confirm",
      "POST /v1/briefs",
      "POST /v1/briefs/{id}/sources",
      "POST /v1/briefs/{id}/run",
      "POST /v1/briefs/{id}/save",
      "POST /v1/agents/{agent}",
      "POST /v1/items/fetch",
    ]);
  });
});

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
function scimReq(method: string, path: string, token: string | undefined, body?: unknown): Request {
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

describe("dispatchWriteRoute — SCIM writes flow through the I13 pipeline", () => {
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

function policyContext(authored: string[]) {
  const db = openSeededInMemoryDb(36);
  return {
    writeDb: db,
    expectedToken: "deploy-token",
    rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    nowMs: () => 1_700_000_000_000,
    knownServices: (): readonly string[] => [],
    policy: {
      token: "admin-secret",
      authorPolicy: async (
        toml: string,
      ): Promise<
        | { ok: true; bundle: { toml: string; sig: string }; org: string; version: number }
        | { ok: false; error: string }
      > => {
        authored.push(toml);
        if (!toml.includes("org")) return { ok: false, error: "policy.org is required" };
        return { ok: true, bundle: { toml, sig: "SIG" }, org: "acme", version: 2 };
      },
    },
  };
}

describe("dispatchWriteRoute — PUT /v1/admin/policy (anchor policy write)", () => {
  it("404s when the policy surface is not wired", async () => {
    const { policy: _p, ...noPolicy } = policyContext([]);
    const res = await dispatchWriteRoute(
      scimReq("PUT", "/v1/admin/policy", "admin-secret", { toml: "org" }),
      noPolicy,
    );
    expect(res.status).toBe(404);
  });

  it("rejects a missing bearer with 401", async () => {
    const ctx = policyContext([]);
    const res = await dispatchWriteRoute(
      scimReq("PUT", "/v1/admin/policy", undefined, { toml: "org" }),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("applies a valid policy with a valid bearer (200, never the privkey)", async () => {
    const authored: string[] = [];
    const ctx = policyContext(authored);
    const res = await dispatchWriteRoute(
      scimReq("PUT", "/v1/admin/policy", "admin-secret", { toml: '[policy]\norg = "acme"\n' }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { applied: boolean; org: string; version: number } };
    expect(body.data.applied).toBe(true);
    expect(body.data.org).toBe("acme");
    expect(body.data.version).toBe(2);
    expect(authored).toHaveLength(1);
  });

  it("rejects a missing/non-string toml with 400 (audit row)", async () => {
    const ctx = policyContext([]);
    const res = await dispatchWriteRoute(
      scimReq("PUT", "/v1/admin/policy", "admin-secret", { toml: 123 }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(auditCount(ctx.writeDb, "policy.applied_rejected")).toBe(1);
  });

  it("surfaces an author validation failure as 400", async () => {
    const ctx = policyContext([]);
    const res = await dispatchWriteRoute(
      scimReq("PUT", "/v1/admin/policy", "admin-secret", { toml: "version = 1" }),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("org");
  });

  // line 188 branch: method !== "PUT" → 405 + Allow: PUT
  it("405 + Allow: PUT when the policy route receives a non-PUT method", async () => {
    const ctx = policyContext([]);
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/v1/admin/policy", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
        body: JSON.stringify({ toml: "org" }),
      }),
      ctx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("PUT");
  });
});

// ── Method-not-allowed / disabled branches (lines 202, 216, 235, 236) ─────────────────────────

describe("dispatchWriteRoute — SCIM / Teams 405 and 404 method/disabled branches", () => {
  // line 202: resolveScimCreateRoute method !== "POST" → 405
  it("405 + Allow: POST when a PUT hits /scim/v2/Users with SCIM enabled", async () => {
    const ctx = scimContext();
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/scim/v2/Users", {
        method: "PUT",
        headers: { authorization: "Bearer scim-secret", "content-type": "application/json" },
        body: JSON.stringify({ externalId: "u1" }),
      }),
      ctx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  // line 216: resolveTeamsEventsRoute method !== "POST" → 405
  it("405 when a GET hits /v1/messaging/teams/events with messaging enabled", async () => {
    const ctx = {
      ...scimContext(),
      messaging: {
        teamsBotAppId: "app-1",
        validateBotJwt: async () => true,
        onActivity: async () => {},
      },
    };
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/v1/messaging/teams/events", { method: "GET" }),
      ctx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  // line 235: resolveScimItemRoute method !== "PATCH" && !== "DELETE" → 405
  it("405 + Allow: PATCH, DELETE when a POST hits a SCIM item path with SCIM enabled", async () => {
    const ctx = scimContext();
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/scim/v2/Users/abc", {
        method: "POST",
        headers: { authorization: "Bearer scim-secret", "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      ctx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("PATCH, DELETE");
  });

  // line 236: resolveScimItemRoute ctx.scim === undefined → 404
  it("404 when PATCH hits a SCIM item path but SCIM surface is not wired", async () => {
    const { scim: _scim, ...noScim } = scimContext();
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/scim/v2/Users/abc", {
        method: "PATCH",
        headers: { authorization: "Bearer scim-secret", "content-type": "application/json" },
        body: JSON.stringify({ Operations: [] }),
      }),
      noScim,
    );
    expect(res.status).toBe(404);
  });
});

// ── parseBody — actual body-size limit (line 339) ─────────────────────────────────────────────

describe("dispatchWriteRoute — parseBody body-size cap (line 339)", () => {
  // line 339: bodyBytes.byteLength > MAX_BODY_BYTES without a content-length trip (line 317).
  // A ReadableStream body omits the content-length header so the pre-read check at line 316 is
  // skipped; the actual ArrayBuffer read at line 339 then catches the oversize.
  it("413 payload_too_large when body is >8 KB via ReadableStream (no content-length)", async () => {
    const ctx = scimContext();
    const bigPayload = "x".repeat(8 * 1024 + 1);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bigPayload));
        controller.close();
      },
    });
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/scim/v2/Users", {
        method: "POST",
        headers: { authorization: "Bearer scim-secret" },
        body: stream,
      }),
      ctx,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("payload_too_large");
  });
});

// ── extractService branches (lines 363, 365) ──────────────────────────────────────────────────

// We need a valid deployment body that passes all annotate validations.
function validDeployBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    service: "payment-service",
    provider: "github-actions",
    environment: "prod",
    sha: "abc1234",
    ref: "main",
    status: "success",
    started_at_ms: 1_700_000_000_000,
    ...overrides,
  };
}

function deployContext() {
  // CURRENT_SCHEMA_VERSION: the deployment route calls annotateDeployment, which writes
  // item.resolve_key (added at V52).
  const db = openSeededInMemoryDb(CURRENT_SCHEMA_VERSION);
  return {
    writeDb: db,
    expectedToken: "hunter2",
    rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    nowMs: () => 1_700_000_000_000,
    knownServices: () => ["payment-service"] as readonly string[],
  };
}

describe("dispatchWriteRoute — extractService branches + checkServiceAllowlist", () => {
  // line 363 FALSE arm: body is an object WITHOUT a "service" key → extractService returns undefined
  // line 376 TRUE arm: svc is undefined → checkServiceAllowlist returns undefined (no 400)
  it("proceeds (not a 400 unknown_service) when the deployment body has no service key", async () => {
    const ctx = deployContext();
    // Send a body without service — it will still fail validation for missing service field
    // (DeploymentRpcError with field="service"), but we confirm unknown_service is NOT the error.
    const bodyNoService: Record<string, unknown> = {
      provider: "github-actions",
      environment: "prod",
      sha: "abc1234",
      ref: "main",
      status: "success",
      started_at_ms: 1_700_000_000_000,
    };
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/v1/deployments", {
        method: "POST",
        headers: { authorization: "Bearer hunter2", "content-type": "application/json" },
        body: JSON.stringify(bodyNoService),
      }),
      ctx,
    );
    // DeploymentRpcError for missing service field → 400 invalid_request, NOT unknown_service
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: Array<{ field?: string }> };
    expect(body.error).toBe("invalid_request");
    expect(body.details[0]?.field).toBe("service");
  });

  // line 365 FALSE arm: body has a "service" key but value is non-string → extractService returns undefined
  // svc will be undefined → checkServiceAllowlist returns undefined (no 400 unknown_service)
  it("proceeds (not a 400 unknown_service) when service is a non-string value", async () => {
    const ctx = deployContext();
    const bodyBadService: Record<string, unknown> = {
      service: 123,
      provider: "github-actions",
      environment: "prod",
      sha: "abc1234",
      ref: "main",
      status: "success",
      started_at_ms: 1_700_000_000_000,
    };
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/v1/deployments", {
        method: "POST",
        headers: { authorization: "Bearer hunter2", "content-type": "application/json" },
        body: JSON.stringify(bodyBadService),
      }),
      ctx,
    );
    // Service is numeric → extractService returns undefined → no allowlist check → annotate
    // fails on invalid service field → 400 invalid_request (not unknown_service)
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });
});

// ── runDeploymentRoute — happy path + DeploymentRpcError branches ──────────────────────────────

describe("dispatchWriteRoute — runDeploymentRoute branches", () => {
  // line 408 FALSE arm: ctx.deployEnvironments IS defined → spread into dispatchDeploymentRpc opts
  it("200 with deployEnvironments defined — hit arm returns annotation", async () => {
    const ctx = {
      ...deployContext(),
      deployEnvironments: ["production", "staging"] as readonly string[],
      knownServices: () => ["payment-service"] as readonly string[],
    };
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/v1/deployments", {
        method: "POST",
        headers: { authorization: "Bearer hunter2", "content-type": "application/json" },
        body: JSON.stringify(validDeployBody({ environment: "production" })),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; dora_eligible: boolean };
    expect(body.service).toBe("payment-service");
    expect(body.dora_eligible).toBe(true);
  });

  // lines 423 TRUE + 428 (e.field !== undefined): DeploymentRpcError WITH a field
  // and line 429: service IS a string → service spread in recordRejection
  it("400 invalid_request with field details when annotate fails a named-field validation", async () => {
    const ctx = {
      ...deployContext(),
      // knownServices allows "payment-service" so we get past the allowlist
      knownServices: () => ["payment-service"] as readonly string[],
    };
    // Send an invalid status to trigger AnnotateError on "status" field
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/v1/deployments", {
        method: "POST",
        headers: { authorization: "Bearer hunter2", "content-type": "application/json" },
        body: JSON.stringify(validDeployBody({ status: "bad_status" })),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      details: Array<{ field: string; reason: string }>;
    };
    expect(body.error).toBe("invalid_request");
    expect(body.details[0]?.field).toBe("status");
    expect(typeof body.details[0]?.reason).toBe("string");
  });

  // lines 423 TRUE + 435 (e.field === undefined): DeploymentRpcError WITHOUT a field
  // Triggered when params is not an object (requireParams throws with no field).
  it("400 invalid_request with no field when body is a non-object (array)", async () => {
    const ctx = deployContext();
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/v1/deployments", {
        method: "POST",
        headers: { authorization: "Bearer hunter2", "content-type": "application/json" },
        body: JSON.stringify([1, 2, 3]),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      details: Array<{ reason: string; field?: string }>;
    };
    expect(body.error).toBe("invalid_request");
    // field must be absent (the undefined-field branch → [{ reason: e.message }])
    expect(body.details[0]?.field).toBeUndefined();
    expect(typeof body.details[0]?.reason).toBe("string");
  });
});

// ── runScimRoute — ScimError status branches (lines 455/456/457, 488, 494/507) ────────────────

// A fake ScimWriteSurface whose runScimWrite can be forced to throw a specific ScimError.
// We inject it by overriding the scim surface's store/identity with a throwing proxy.
// The simplest approach: provide a store whose upsertScimUser throws the desired ScimError.

function scimContextThrowing(errorToThrow: unknown) {
  const db = openSeededInMemoryDb(34);
  const realIdentity = new IdentityStore(db);
  // Wrap realIdentity so upsertScimUser throws our chosen error
  const throwingIdentity: IdentityStore = new Proxy(realIdentity, {
    get(target, prop) {
      if (prop === "upsertScimUser") {
        return () => {
          throw errorToThrow;
        };
      }
      return (target as unknown as Record<string, unknown>)[prop as string];
    },
  });
  return {
    writeDb: db,
    expectedToken: "deploy-token",
    rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    nowMs: () => 1_700_000_000_000,
    knownServices: (): readonly string[] => [],
    scim: {
      token: "scim-secret",
      store: new NamespaceStore(db),
      identity: throwingIdentity,
    },
  };
}

describe("dispatchWriteRoute — runScimRoute ScimError / generic-error branches", () => {
  // line 455: scimReason status === 400 → "invalid_request"
  // line 488 TRUE: e instanceof ScimError
  // line 494 TRUE: route.id === undefined (POST /scim/v2/Users — create route, no id)
  it("400 with scim_reason=invalid_request when ScimError(400) thrown on create (no route.id)", async () => {
    const err = new ScimError("bad body", 400);
    const ctx = scimContextThrowing(err);
    const res = await dispatchWriteRoute(
      scimReq("POST", "/scim/v2/Users", "scim-secret", { externalId: "u1", userName: "alice" }),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string; status: number };
    expect(body.status).toBe(400);
    expect(body.detail).toBe("bad body");
  });

  // line 456: scimReason status === 404 → "not_found"
  // line 507 FALSE: route.id IS defined (PATCH /scim/v2/Users/{id} — item route, id = "u1")
  it("404 with scim_reason=not_found when ScimError(404) thrown on item route (route.id defined)", async () => {
    // For PATCH we need to first create the user so the token check passes;
    // but we inject throwing identity to force the error during applyScimPatch.
    // Use a separate context for the patch that has the throwing identity.
    const err = new ScimError("not found", 404);
    const db = openSeededInMemoryDb(34);
    // Normal identity for the create, throwing for the patch
    const realIdentity = new IdentityStore(db);
    // Wrap: getScimUser and setScimActive throw; we simulate PATCH path via parseScimPatchActive
    // which calls into identity. Actually the error needs to come from inside runScimWrite.
    // Since PATCH → applyScimPatch → deprovisionUser or identity.setScimActive, we can
    // make identity.setScimActive throw for active=true case.
    const throwingIdentity: IdentityStore = new Proxy(realIdentity, {
      get(target, prop) {
        if (prop === "setScimActive" || prop === "upsertScimUser") {
          return () => {
            throw err;
          };
        }
        return (target as unknown as Record<string, unknown>)[prop as string];
      },
    });
    const ctx = {
      writeDb: db,
      expectedToken: "deploy-token",
      rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
      nowMs: () => 1_700_000_000_000,
      knownServices: (): readonly string[] => [],
      scim: {
        token: "scim-secret",
        store: new NamespaceStore(db),
        identity: throwingIdentity,
      },
    };
    const res = await dispatchWriteRoute(
      scimReq("PATCH", "/scim/v2/Users/u1", "scim-secret", {
        Operations: [{ op: "replace", path: "active", value: true }],
      }),
      ctx,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { detail: string; status: number };
    expect(body.status).toBe(404);
    expect(body.detail).toBe("not found");
  });

  // line 457: scimReason status === 409 → "conflict"
  it("409 with scim_reason=conflict when ScimError(409) thrown on create", async () => {
    const err = new ScimError("conflict", 409);
    const ctx = scimContextThrowing(err);
    const res = await dispatchWriteRoute(
      scimReq("POST", "/scim/v2/Users", "scim-secret", { externalId: "u1", userName: "alice" }),
      ctx,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { status: number };
    expect(body.status).toBe(409);
  });

  // line 488 FALSE + line 502-509: non-ScimError thrown → generic 500 internal_error
  // line 494 TRUE: create route, route.id undefined
  it("500 internal_error when a non-ScimError is thrown from the SCIM handler (create route)", async () => {
    const nonScimErr: unknown = new Error("unexpected db failure");
    const ctx = scimContextThrowing(nonScimErr);
    const res = await dispatchWriteRoute(
      scimReq("POST", "/scim/v2/Users", "scim-secret", { externalId: "u1", userName: "alice" }),
      ctx,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });

  // line 507 FALSE (item route, route.id IS defined): non-ScimError on item PATCH → 500
  it("500 internal_error when a non-ScimError is thrown from the SCIM handler (item route)", async () => {
    const nonScimErr: unknown = new Error("unexpected db failure on patch");
    const db = openSeededInMemoryDb(34);
    const realIdentity = new IdentityStore(db);
    const throwingIdentity: IdentityStore = new Proxy(realIdentity, {
      get(target, prop) {
        if (prop === "setScimActive" || prop === "upsertScimUser") {
          return () => {
            throw nonScimErr;
          };
        }
        return (target as unknown as Record<string, unknown>)[prop as string];
      },
    });
    const ctx = {
      writeDb: db,
      expectedToken: "deploy-token",
      rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
      nowMs: () => 1_700_000_000_000,
      knownServices: (): readonly string[] => [],
      scim: {
        token: "scim-secret",
        store: new NamespaceStore(db),
        identity: throwingIdentity,
      },
    };
    const res = await dispatchWriteRoute(
      scimReq("PATCH", "/scim/v2/Users/u99", "scim-secret", {
        Operations: [{ op: "replace", path: "active", value: true }],
      }),
      ctx,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });
});

// ── Web clipper routes (POST /v1/clips, POST /v1/clips/pair/confirm) ─────────────────────────

function baseWriteCtx(): WriteRouteContext {
  return {
    writeDb: openSeededInMemoryDb(28),
    expectedToken: "",
    rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    nowMs: () => 1000,
    knownServices: () => [],
  };
}

function clipsSurface(over: Partial<ClipsWriteSurface> = {}): ClipsWriteSurface {
  const pairing = new PairingWindowController({ nowMs: () => 1000, genCode: () => "123456" });
  return {
    pairing,
    verifyToken: async (t) =>
      t === "good-token" ? { label: "chrome", scopes: ["clip", "briefs"] } : null,
    mintToken: async () => "minted-token",
    ingest: () => ({ id: "nimbus:clip:abc", status: "created" }),
    ...over,
  };
}

function clipCtx(over: Partial<WriteRouteContext> = {}): WriteRouteContext {
  return { ...baseWriteCtx(), clips: clipsSurface(), ...over };
}

test("POST /v1/clips with a valid token ingests and returns 200 created", async () => {
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token", "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://ex.com/p",
      title: "T",
      mode: "article",
      body: "b",
      capturedAt: 1750000000000,
    }),
  });
  const res = await dispatchWriteRoute(req, clipCtx());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: "nimbus:clip:abc", status: "created" });
});

test("POST /v1/clips with a bad token → 401 (no ingest)", async () => {
  let ingested = false;
  const ctx = clipCtx({
    clips: clipsSurface({
      ingest: () => {
        ingested = true;
        return { id: "x", status: "created" };
      },
    }),
  });
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer WRONG", "content-type": "application/json" },
    body: JSON.stringify({ url: "u", title: "t", mode: "article", body: "b", capturedAt: 1 }),
  });
  const res = await dispatchWriteRoute(req, ctx);
  expect(res.status).toBe(401);
  expect(ingested).toBe(false);
});

test("POST /v1/clips with invalid payload → 400 with field", async () => {
  const ctx = clipCtx({
    clips: clipsSurface({
      ingest: () => {
        throw new ClipValidationError("mode required", "mode");
      },
    }),
  });
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token", "content-type": "application/json" },
    body: JSON.stringify({ url: "u", title: "t", mode: "x", body: "b", capturedAt: 1 }),
  });
  const res = await dispatchWriteRoute(req, ctx);
  expect(res.status).toBe(400);
});

test("pair/confirm with the right code mints a token (window open)", async () => {
  const surface = clipsSurface();
  surface.pairing.open("chrome-work", ["clip"]);
  const req = new Request("http://127.0.0.1/v1/clips/pair/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
  });
  const res = await dispatchWriteRoute(req, clipCtx({ clips: surface }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    token: "minted-token",
    label: "chrome-work",
    scopes: ["clip"],
  });
});

test("pair/confirm fail-closed: no window open → 403, no mint", async () => {
  let minted = false;
  const surface = clipsSurface({
    mintToken: async () => {
      minted = true;
      return "x";
    },
  });
  // window NOT opened
  const req = new Request("http://127.0.0.1/v1/clips/pair/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
  });
  const res = await dispatchWriteRoute(req, clipCtx({ clips: surface }));
  expect(res.status).toBe(403);
  expect(minted).toBe(false);
});

test("clip routes are 404 when the clips seam is absent", async () => {
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token" },
    body: "{}",
  });
  const res = await dispatchWriteRoute(req, baseWriteCtx());
  expect(res.status).toBe(404);
});

test("POST /v1/clips with no Authorization header → 401", async () => {
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "u", title: "t", mode: "article", body: "b", capturedAt: 1 }),
  });
  const res = await dispatchWriteRoute(req, clipCtx());
  expect(res.status).toBe(401);
});

test("POST /v1/clips → 500 when ingest throws a non-validation error", async () => {
  const ctx = clipCtx({
    clips: clipsSurface({
      ingest: () => {
        throw new Error("boom");
      },
    }),
  });
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token", "content-type": "application/json" },
    body: JSON.stringify({ url: "u", title: "t", mode: "article", body: "b", capturedAt: 1 }),
  });
  const res = await dispatchWriteRoute(req, ctx);
  expect(res.status).toBe(500);
});

test("POST /v1/clips → 400 without a field key when the validation error has no field", async () => {
  const ctx = clipCtx({
    clips: clipsSurface({
      ingest: () => {
        throw new ClipValidationError("body must be an object");
      },
    }),
  });
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token", "content-type": "application/json" },
    body: JSON.stringify({ url: "u", title: "t", mode: "article", body: "b", capturedAt: 1 }),
  });
  const res = await dispatchWriteRoute(req, ctx);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid_request" });
});

test("pair/confirm with a non-string code → 403", async () => {
  const surface = clipsSurface();
  surface.pairing.open("dev", ["clip"]);
  const req = new Request("http://127.0.0.1/v1/clips/pair/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: 123456 }),
  });
  const res = await dispatchWriteRoute(req, clipCtx({ clips: surface }));
  expect(res.status).toBe(403);
});

test("pair/confirm with no code field → 403", async () => {
  const surface = clipsSurface();
  surface.pairing.open("dev", ["clip"]);
  const req = new Request("http://127.0.0.1/v1/clips/pair/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const res = await dispatchWriteRoute(req, clipCtx({ clips: surface }));
  expect(res.status).toBe(403);
});

// ── Per-route body cap (#771) ────────────────────────────────────────────────────────────────
// The I13 dispatcher's body cap is per-route: control-plane routes keep the 8 KiB anti-abuse
// bound, while `POST /v1/clips` carries a real article body and gets 1 MiB. Both enforcement
// sites (the content-length pre-check and the post-read byteLength check) must use the cap of
// the route that was resolved.

const KIB_8 = 8 * 1024;
const MIB_1 = 1024 * 1024;

/** A clip body whose JSON encoding is at least `bytes` long. */
function clipBodyOfAtLeast(bytes: number): string {
  return JSON.stringify({
    url: "https://ex.com/article",
    title: "T",
    mode: "article",
    body: "a".repeat(bytes),
    capturedAt: 1750000000000,
  });
}

/** A clip body whose JSON encoding is exactly `bytes` long (ASCII only, so bytes === chars). */
function clipBodyOfExactly(bytes: number): string {
  return clipBodyOfAtLeast(bytes - clipBodyOfAtLeast(0).length);
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

test("POST /v1/clips accepts a 32 KiB article body (over the 8 KiB control-plane cap)", async () => {
  const payload = clipBodyOfAtLeast(32 * 1024);
  expect(payload.length).toBeGreaterThan(KIB_8);
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token", "content-type": "application/json" },
    body: payload,
  });
  const res = await dispatchWriteRoute(req, clipCtx());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: "nimbus:clip:abc", status: "created" });
});

test("POST /v1/clips accepts a 32 KiB body with no content-length (streamed)", async () => {
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token" },
    body: streamOf(clipBodyOfAtLeast(32 * 1024)),
  });
  const res = await dispatchWriteRoute(req, clipCtx());
  expect(res.status).toBe(200);
});

test("POST /v1/clips still rejects a body over 1 MiB with 413 (content-length pre-check)", async () => {
  let ingested = false;
  const ctx = clipCtx({
    clips: clipsSurface({
      ingest: () => {
        ingested = true;
        return { id: "x", status: "created" };
      },
    }),
  });
  const payload = clipBodyOfAtLeast(MIB_1 + 1);
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token", "content-type": "application/json" },
    body: payload,
  });
  const res = await dispatchWriteRoute(req, ctx);
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: "payload_too_large" });
  // The clip route reports its own tighter limit (20/min), not the shared 60/min.
  expect(res.headers.get("X-RateLimit-Limit")).toBe("20");
  expect(ingested).toBe(false);
});

test("POST /v1/clips still rejects a body over 1 MiB with 413 when streamed (byteLength check)", async () => {
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token" },
    body: streamOf(clipBodyOfAtLeast(MIB_1 + 1)),
  });
  const res = await dispatchWriteRoute(req, clipCtx());
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: "payload_too_large" });
});

test("POST /v1/deployments keeps the 8 KiB cap (the clip cap is not global)", async () => {
  const ctx = deployContext();
  const req = new Request("http://127.0.0.1/v1/deployments", {
    method: "POST",
    headers: { authorization: "Bearer hunter2", "content-type": "application/json" },
    body: JSON.stringify(validDeployBody({ note: "n".repeat(KIB_8) })),
  });
  const res = await dispatchWriteRoute(req, ctx);
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: "payload_too_large" });
});

test("POST /v1/clips accepts a body of exactly 1 MiB (the cap is inclusive)", async () => {
  const payload = clipBodyOfExactly(MIB_1);
  expect(payload).toHaveLength(MIB_1);
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token", "content-type": "application/json" },
    body: payload,
  });
  const res = await dispatchWriteRoute(req, clipCtx());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: "nimbus:clip:abc", status: "created" });
});

test("POST /v1/clips rejects a body of exactly 1 MiB + 1 with 413", async () => {
  const payload = clipBodyOfExactly(MIB_1 + 1);
  expect(payload).toHaveLength(MIB_1 + 1);
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token", "content-type": "application/json" },
    body: payload,
  });
  const res = await dispatchWriteRoute(req, clipCtx());
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: "payload_too_large" });
});

// ── Per-route rate limit (#771) ──────────────────────────────────────────────────────────────
// The 1 MiB clip cap is paid for with a tighter per-route rate limit: `POST /v1/clips` gets
// 20/min while every other write route keeps 60/min. The X-RateLimit-* headers must report the
// limit that actually applied.

const CLIP_RATE_LIMIT = 20;

function clipIngestReq(): Request {
  return new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token", "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://ex.com/p",
      title: "T",
      mode: "article",
      body: "b",
      capturedAt: 1750000000000,
    }),
  });
}

test("POST /v1/clips is rate-limited at 20/min, not the shared 60/min", async () => {
  const ctx = clipCtx();
  const first = await dispatchWriteRoute(clipIngestReq(), ctx);
  expect(first.status).toBe(200);
  expect(first.headers.get("X-RateLimit-Limit")).toBe(String(CLIP_RATE_LIMIT));
  expect(first.headers.get("X-RateLimit-Remaining")).toBe(String(CLIP_RATE_LIMIT - 1));
  for (let i = 1; i < CLIP_RATE_LIMIT; i += 1) {
    const res = await dispatchWriteRoute(clipIngestReq(), ctx);
    expect(res.status).toBe(200);
  }
  const over = await dispatchWriteRoute(clipIngestReq(), ctx);
  expect(over.status).toBe(429);
  expect(await over.json()).toEqual({ error: "rate_limited" });
  expect(over.headers.get("X-RateLimit-Limit")).toBe(String(CLIP_RATE_LIMIT));
  expect(over.headers.get("X-RateLimit-Remaining")).toBe("0");
  expect(auditCount(ctx.writeDb, "clip.ingest_rejected")).toBe(1);
});

test("the tighter clip limit does not leak: deployments still get 60/min", async () => {
  const ctx = deployContext();
  for (let i = 0; i < CLIP_RATE_LIMIT + 5; i += 1) {
    const res = await dispatchWriteRoute(
      new Request("http://127.0.0.1/v1/deployments", {
        method: "POST",
        headers: { authorization: "Bearer hunter2", "content-type": "application/json" },
        body: JSON.stringify(validDeployBody({ sha: `abc${1000 + i}` })),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
  }
});

test("POST /v1/clips/pair/confirm keeps the 8 KiB cap (a pairing code is tiny)", async () => {
  let minted = false;
  const surface = clipsSurface({
    mintToken: async () => {
      minted = true;
      return "x";
    },
  });
  surface.pairing.open("chrome-work", ["clip"]);
  const req = new Request("http://127.0.0.1/v1/clips/pair/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "123456", pad: "p".repeat(KIB_8) }),
  });
  const res = await dispatchWriteRoute(req, clipCtx({ clips: surface }));
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: "payload_too_large" });
  expect(minted).toBe(false);
});

// ── Research-brief routes (POST /v1/briefs, .../sources, .../run, .../save) ───────────────────

const BRIEF_TOKEN = "good-brief-token";

function blankReport(): Report {
  return {
    summary: "s",
    findings: [],
    conflicts: [],
    gaps: [],
    synthesis: { model: "m", remote: false },
  };
}

function briefsSurface(over: Partial<BriefsWriteSurface> = {}): BriefsWriteSurface {
  return {
    controller: over.controller ?? new BriefRunController({ nowMs: () => 1000 }),
    verifyToken:
      over.verifyToken ??
      (async (t: string) =>
        t === BRIEF_TOKEN ? { label: "chrome", scopes: ["clip", "briefs"] } : null),
    startRun: over.startRun ?? (() => {}),
    save: over.save ?? (() => ({ itemId: "nimbus:research_brief:abc" })),
  };
}

function briefCtx(over: Partial<WriteRouteContext> = {}): WriteRouteContext {
  return { ...baseWriteCtx(), briefs: briefsSurface(), ...over };
}

// `token: null` (NOT `undefined`, which triggers the default-parameter substitution and would
// silently send the valid bearer) means "send no Authorization header at all".
function briefReq(path: string, body?: unknown, token: string | null = BRIEF_TOKEN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function validCreateBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brief: "What is the capital of France?",
    sources: [{ url: "https://ex.com/a", title: "A" }],
    useIndex: false,
    ...over,
  };
}

function validSourceBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "https://ex.com/a",
    title: "A",
    body: "body text",
    capturedAt: 1_700_000_000_000,
    truncated: false,
    ...over,
  };
}

/** Creates a run directly on the controller (bypassing HTTP) and unwraps the CreateResult. */
function seedRun(controller: BriefRunController, over: Record<string, unknown> = {}) {
  const out: CreateResult = controller.create({
    brief: "q",
    sources: [{ url: "https://ex.com/a", title: "A" }],
    useIndex: false,
    ...over,
  } as Parameters<BriefRunController["create"]>[0]);
  if (!("run" in out)) throw new Error("test setup: seedRun hit the concurrency cap");
  return out.run;
}

test("POST /v1/briefs with a valid body creates a run (200 collecting)", async () => {
  const ctx = briefCtx();
  const res = await dispatchWriteRoute(briefReq("/v1/briefs", validCreateBody()), ctx);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string; status: string; expected: number };
  expect(body.status).toBe("collecting");
  expect(body.expected).toBe(1);
  expect(typeof body.id).toBe("string");
});

test("POST /v1/briefs 404s briefs_disabled when the briefs seam is absent", async () => {
  const res = await dispatchWriteRoute(briefReq("/v1/briefs", validCreateBody()), baseWriteCtx());
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string; hint: string };
  expect(body.error).toBe("briefs_disabled");
});

test("405 + Allow: POST when a GET hits /v1/briefs with briefs enabled", async () => {
  const res = await dispatchWriteRoute(
    new Request("http://127.0.0.1/v1/briefs", { method: "GET" }),
    briefCtx(),
  );
  expect(res.status).toBe(405);
  expect(res.headers.get("Allow")).toBe("POST");
});

test("POST /v1/briefs with an invalid body (missing brief) -> 400 field brief", async () => {
  const ctx = briefCtx();
  const res = await dispatchWriteRoute(
    briefReq("/v1/briefs", { sources: [{ url: "https://ex.com/a", title: "A" }], useIndex: false }),
    ctx,
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; field?: string };
  expect(body.error).toBe("invalid_request");
  expect(body.field).toBe("brief");
  expect(auditCount(ctx.writeDb, "brief.create_rejected")).toBe(1);
});

test("POST /v1/briefs returns 503 briefs_busy (no Retry-After) when MAX_CONCURRENT_RUNS are live", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  for (let i = 0; i < MAX_CONCURRENT_RUNS; i += 1) {
    seedRun(controller, { brief: `q${i}`, sources: [{ url: `https://ex.com/${i}`, title: "t" }] });
  }
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const res = await dispatchWriteRoute(briefReq("/v1/briefs", validCreateBody()), ctx);
  expect(res.status).toBe(503);
  const body = (await res.json()) as {
    error: string;
    activeRuns: number;
    oldestExpiresInSeconds: number;
  };
  expect(body.error).toBe("briefs_busy");
  expect(body.activeRuns).toBe(MAX_CONCURRENT_RUNS);
  expect(typeof body.oldestExpiresInSeconds).toBe("number");
  // Load-bearing: NOT a 429 and NEVER a Retry-After (see the dispatcher's comment on why).
  expect(res.headers.get("Retry-After")).toBeNull();
  expect(auditCount(ctx.writeDb, "brief.create_rejected")).toBe(1);
});

test("POST /v1/briefs with no bearer -> 401, run not created", async () => {
  const ctx = briefCtx();
  const res = await dispatchWriteRoute(briefReq("/v1/briefs", validCreateBody(), null), ctx);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
  expect(auditCount(ctx.writeDb, "brief.create_rejected")).toBe(1);
});

test("POST /v1/briefs/{id}/sources feeds a declared source (200 accepted)", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const res = await dispatchWriteRoute(
    briefReq(`/v1/briefs/${run.id}/sources`, validSourceBody()),
    ctx,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { accepted: boolean; received: number; expected: number };
  expect(body.accepted).toBe(true);
  expect(body.received).toBe(1);
  expect(body.expected).toBe(1);
});

test("POST /v1/briefs/{id}/sources with an undeclared URL -> 400 field url", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const res = await dispatchWriteRoute(
    briefReq(
      `/v1/briefs/${run.id}/sources`,
      validSourceBody({ url: "https://ex.com/NOT-DECLARED" }),
    ),
    ctx,
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; field?: string };
  expect(body.error).toBe("invalid_request");
  expect(body.field).toBe("url");
  expect(auditCount(ctx.writeDb, "brief.source_rejected")).toBe(1);
});

test("POST /v1/briefs/{id}/sources with a malformed body (missing capturedAt) -> 400 field capturedAt", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const { capturedAt: _capturedAt, ...malformed } = validSourceBody();
  const res = await dispatchWriteRoute(briefReq(`/v1/briefs/${run.id}/sources`, malformed), ctx);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; field?: string };
  expect(body.field).toBe("capturedAt");
});

test("POST /v1/briefs/{id}/sources over MAX_SOURCE_BYTES -> 413 detail source_too_large", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const res = await dispatchWriteRoute(
    briefReq(
      `/v1/briefs/${run.id}/sources`,
      validSourceBody({ body: "x".repeat(MAX_SOURCE_BYTES + 1) }),
    ),
    ctx,
  );
  expect(res.status).toBe(413);
  const body = (await res.json()) as { error: string; detail: string };
  expect(body.error).toBe("payload_too_large");
  expect(body.detail).toBe("source_too_large");
  expect(auditCount(ctx.writeDb, "brief.source_rejected")).toBe(1);
});

test("POST /v1/briefs/{id}/sources on a non-collecting run -> 409 invalid_state", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  controller.markRunning(run);
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const res = await dispatchWriteRoute(
    briefReq(`/v1/briefs/${run.id}/sources`, validSourceBody()),
    ctx,
  );
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "invalid_state" });
  expect(auditCount(ctx.writeDb, "brief.source_rejected")).toBe(1);
});

test("POST /v1/briefs/{id}/sources for an unknown id -> 404 not_found", async () => {
  const ctx = briefCtx();
  const res = await dispatchWriteRoute(
    briefReq("/v1/briefs/nonexistent12345/sources", validSourceBody()),
    ctx,
  );
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
  expect(auditCount(ctx.writeDb, "brief.source_rejected")).toBe(1);
});

test("POST /v1/briefs/{id}/sources for an expired run -> 410 expired", async () => {
  let now = 0;
  const controller = new BriefRunController({ nowMs: () => now, ttlMs: 1000 });
  const run = seedRun(controller);
  now = 5000; // past the 1000ms TTL
  const ctx: WriteRouteContext = {
    ...briefCtx({ briefs: briefsSurface({ controller }) }),
    nowMs: () => now,
  };
  const res = await dispatchWriteRoute(
    briefReq(`/v1/briefs/${run.id}/sources`, validSourceBody()),
    ctx,
  );
  expect(res.status).toBe(410);
  expect(await res.json()).toEqual({ error: "expired" });
  expect(auditCount(ctx.writeDb, "brief.source_rejected")).toBe(1);
});

test("POST /v1/briefs/{id}/sources with no bearer -> 401", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const res = await dispatchWriteRoute(
    briefReq(`/v1/briefs/${run.id}/sources`, validSourceBody(), null),
    ctx,
  );
  expect(res.status).toBe(401);
});

test("405 + Allow: POST when a GET hits a brief item path with briefs enabled", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  const res = await dispatchWriteRoute(
    new Request(`http://127.0.0.1/v1/briefs/${run.id}/sources`, { method: "GET" }),
    briefCtx({ briefs: briefsSurface({ controller }) }),
  );
  expect(res.status).toBe(405);
  expect(res.headers.get("Allow")).toBe("POST");
});

test("brief item routes 404 briefs_disabled when the briefs seam is absent", async () => {
  const res = await dispatchWriteRoute(
    briefReq("/v1/briefs/abc123/sources", validSourceBody()),
    baseWriteCtx(),
  );
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("briefs_disabled");
});

test("POST /v1/briefs/{id}/run with a fed source -> 200 running, startRun called once", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  controller.addSource(run, {
    url: "https://ex.com/a",
    title: "A",
    body: "b",
    capturedAt: 1_700_000_000_000,
    truncated: false,
  });
  const started: string[] = [];
  const ctx = briefCtx({
    briefs: briefsSurface({
      controller,
      startRun: (id: string) => {
        started.push(id);
      },
    }),
  });
  const res = await dispatchWriteRoute(briefReq(`/v1/briefs/${run.id}/run`), ctx);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "running" });
  expect(started).toEqual([run.id]);
});

test("POST /v1/briefs/{id}/run with useIndex=true and zero fed sources still runs", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller, { useIndex: true });
  const started: string[] = [];
  const ctx = briefCtx({
    briefs: briefsSurface({
      controller,
      startRun: (id: string) => {
        started.push(id);
      },
    }),
  });
  const res = await dispatchWriteRoute(briefReq(`/v1/briefs/${run.id}/run`), ctx);
  expect(res.status).toBe(200);
  expect(started).toEqual([run.id]);
});

test("POST /v1/briefs/{id}/run with zero fed sources and useIndex=false -> 400 field sources", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const res = await dispatchWriteRoute(briefReq(`/v1/briefs/${run.id}/run`), ctx);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; field?: string };
  expect(body.error).toBe("invalid_request");
  expect(body.field).toBe("sources");
  expect(auditCount(ctx.writeDb, "brief.run_rejected")).toBe(1);
});

test("POST /v1/briefs/{id}/run is idempotent: re-calling on a running run reports status, no restart", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  controller.markRunning(run);
  const started: string[] = [];
  const ctx = briefCtx({
    briefs: briefsSurface({
      controller,
      startRun: (id: string) => {
        started.push(id);
      },
    }),
  });
  const res = await dispatchWriteRoute(briefReq(`/v1/briefs/${run.id}/run`), ctx);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "running" });
  expect(started).toEqual([]);
});

test("POST /v1/briefs/{id}/run for an unknown id -> 404 not_found", async () => {
  const ctx = briefCtx();
  const res = await dispatchWriteRoute(briefReq("/v1/briefs/nonexistent12345/run"), ctx);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
  expect(auditCount(ctx.writeDb, "brief.run_rejected")).toBe(1);
});

test("POST /v1/briefs/{id}/run with a wrong bearer -> 401", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const res = await dispatchWriteRoute(
    briefReq(`/v1/briefs/${run.id}/run`, undefined, "wrong-token"),
    ctx,
  );
  expect(res.status).toBe(401);
});

test("POST /v1/briefs/{id}/run with no bearer -> 401", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const res = await dispatchWriteRoute(briefReq(`/v1/briefs/${run.id}/run`, undefined, null), ctx);
  expect(res.status).toBe(401);
});

test("POST /v1/briefs/{id}/save on a done run -> 200 with the surface's itemId", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  controller.finish(run, blankReport());
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const res = await dispatchWriteRoute(briefReq(`/v1/briefs/${run.id}/save`), ctx);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ itemId: "nimbus:research_brief:abc" });
});

test("POST /v1/briefs/{id}/save on a non-done (collecting) run -> 409 invalid_state", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const res = await dispatchWriteRoute(briefReq(`/v1/briefs/${run.id}/save`), ctx);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "invalid_state" });
  expect(auditCount(ctx.writeDb, "brief.save_rejected")).toBe(1);
});

test("POST /v1/briefs/{id}/save maps ReportTooLargeError to 409 report_too_large (not 500)", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  controller.finish(run, blankReport());
  const ctx = briefCtx({
    briefs: briefsSurface({
      controller,
      save: () => {
        throw new ReportTooLargeError();
      },
    }),
  });
  const res = await dispatchWriteRoute(briefReq(`/v1/briefs/${run.id}/save`), ctx);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "report_too_large" });
  expect(auditCount(ctx.writeDb, "brief.save_rejected")).toBe(1);
});

test("POST /v1/briefs/{id}/save maps a non-ReportTooLargeError throw to 500 internal_error", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  controller.finish(run, blankReport());
  const ctx = briefCtx({
    briefs: briefsSurface({
      controller,
      save: () => {
        throw new Error("run not found");
      },
    }),
  });
  const res = await dispatchWriteRoute(briefReq(`/v1/briefs/${run.id}/save`), ctx);
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "internal_error" });
});

test("POST /v1/briefs/{id}/save for an unknown id -> 404 not_found", async () => {
  const ctx = briefCtx();
  const res = await dispatchWriteRoute(briefReq("/v1/briefs/nonexistent12345/save"), ctx);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
  expect(auditCount(ctx.writeDb, "brief.save_rejected")).toBe(1);
});

test("POST /v1/briefs/{id}/save with no bearer -> 401", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  controller.finish(run, blankReport());
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const res = await dispatchWriteRoute(briefReq(`/v1/briefs/${run.id}/save`, undefined, null), ctx);
  expect(res.status).toBe(401);
});

test("brief source-feed and control routes are rate-limited on SEPARATE buckets (brief-src vs brief)", async () => {
  const controller = new BriefRunController({ nowMs: () => 1000 });
  const run = seedRun(controller);
  const ctx = briefCtx({ briefs: briefsSurface({ controller }) });
  const sourceRes = await dispatchWriteRoute(
    briefReq(`/v1/briefs/${run.id}/sources`, validSourceBody()),
    ctx,
  );
  expect(sourceRes.status).toBe(200);
  expect(sourceRes.headers.get("X-RateLimit-Limit")).toBe("60");
  // A second create call still has its own full "brief" bucket — proves the two fingerprints
  // ("brief" and "brief-src") don't share state.
  const createRes = await dispatchWriteRoute(briefReq("/v1/briefs", validCreateBody()), ctx);
  expect(createRes.status).toBe(200);
  expect(createRes.headers.get("X-RateLimit-Remaining")).toBe("59");
});

// --- POST /v1/agents/{agent} (I13 write surface) -------------------------------------------
//
// Exercised through `dispatchWriteRoute` with a FAKE AgentsWriteSurface rather than a real server:
// the property under test is the route wiring — auth, scope, status mapping, Retry-After — not the
// agent machinery, which has its own suite. The end-to-end path gets a real server separately.

const AGENT_TOKEN = "agents-route-token-0123456789abcdef0123456789ab";

function agentsContext(
  invoke: AgentHttpInvoker,
  scopes: readonly ApiScope[] = ["agents"],
): WriteRouteContext {
  return {
    writeDb: openSeededInMemoryDb(44),
    expectedToken: "",
    rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    nowMs: () => 1_700_000_000_000,
    knownServices: (): readonly string[] => [],
    agents: {
      verifyToken: async (presented: string) =>
        presented === AGENT_TOKEN ? { label: "chrome-work", scopes } : null,
      invoke,
    },
  };
}

function agentReq(path: string, token: string | null = AGENT_TOKEN): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ topicOrFile: "auth.ts" }),
  });
}

const okInvoke: AgentHttpInvoker = async () => ({ ok: true, runId: "expert_1_abcd1234" });

describe("POST /v1/agents/{agent}", () => {
  it("returns 202 and the run id for an agents-scoped token", async () => {
    const res = await dispatchWriteRoute(agentReq("/v1/agents/expert"), agentsContext(okInvoke));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: "expert_1_abcd1234" });
  });

  it("passes the VERIFIED token label through as the invoker's client label", async () => {
    // That label becomes caller.clientId on the egress row. If the route passed anything
    // caller-supplied, the ledger would record an assertion rather than an observation.
    const seenLabels: string[] = [];
    const capture: AgentHttpInvoker = async (_a, _p, label) => {
      seenLabels.push(label);
      return { ok: true, runId: "expert_1_abcd1234" };
    };
    await dispatchWriteRoute(agentReq("/v1/agents/expert"), agentsContext(capture));
    expect(seenLabels).toEqual(["chrome-work"]);
  });

  it("passes the body through VERBATIM — no params are built here", async () => {
    let seenParams: unknown = null;
    const capture: AgentHttpInvoker = async (_a, params) => {
      seenParams = params;
      return { ok: true, runId: "expert_1_abcd1234" };
    };
    await dispatchWriteRoute(agentReq("/v1/agents/expert"), agentsContext(capture));
    expect(seenParams).toEqual({ topicOrFile: "auth.ts" });
  });

  it("is 401 for an unknown token, NOT 403", async () => {
    // Authentication failure must stay distinguishable from authorization failure: a client that
    // sees 401 re-pairs, a client that sees 403 asks for a scope. Collapsing them misroutes both.
    const res = await dispatchWriteRoute(
      agentReq("/v1/agents/expert", "wrong-token"),
      agentsContext(okInvoke),
    );
    expect(res.status).toBe(401);
  });

  it("is 403 insufficient_scope for a clip+briefs token", async () => {
    const res = await dispatchWriteRoute(
      agentReq("/v1/agents/expert"),
      agentsContext(okInvoke, ["clip", "briefs"]),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "insufficient_scope",
      required: "agents",
      granted: ["clip", "briefs"],
    });
  });

  it("is 404 unknown_agent when the invoker refuses the name", async () => {
    const refuse: AgentHttpInvoker = async () => ({ ok: false, reason: "unknown_agent" });
    const res = await dispatchWriteRoute(agentReq("/v1/agents/preflight"), agentsContext(refuse));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_agent" });
  });

  it("is 400 invalid_params with the validator's own message", async () => {
    const refuse: AgentHttpInvoker = async () => ({
      ok: false,
      reason: "invalid_params",
      detail: "topicOrFile must be a string",
    });
    const res = await dispatchWriteRoute(agentReq("/v1/agents/expert"), agentsContext(refuse));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_params",
      detail: "topicOrFile must be a string",
    });
  });

  it("is 429 WITH Retry-After when the run store is at capacity", async () => {
    // Two different 429s reach a client from this route: the per-token rate limiter's and this
    // capacity refusal. A client backing off by Retry-After must not have to know which it got.
    const busy: AgentHttpInvoker = async () => ({
      ok: false,
      reason: "busy",
      activeRuns: 3,
      oldestExpiresInSeconds: 42,
    });
    const res = await dispatchWriteRoute(agentReq("/v1/agents/expert"), agentsContext(busy));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(await res.json()).toEqual({ error: "busy", activeRuns: 3, oldestExpiresInSeconds: 42 });
  });

  it("omits oldestExpiresInSeconds when the store cannot support a number", async () => {
    const busy: AgentHttpInvoker = async () => ({
      ok: false,
      reason: "busy",
      activeRuns: 3,
      oldestExpiresInSeconds: null,
    });
    const res = await dispatchWriteRoute(agentReq("/v1/agents/expert"), agentsContext(busy));
    expect(await res.json()).toEqual({ error: "busy", activeRuns: 3 });
    // The header is still present: the client's instruction does not depend on the context field.
    expect(res.headers.get("Retry-After")).toBe("1");
  });

  it("is 500 with NO run when the egress append fails — I29 fail-closed", async () => {
    const throwing: AgentHttpInvoker = async () => {
      throw new Error("egress_ledger is gone");
    };
    const res = await dispatchWriteRoute(agentReq("/v1/agents/expert"), agentsContext(throwing));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });

  it("404s when the agents seam is absent, naming the cause", async () => {
    // Built WITHOUT the key rather than with `agents: undefined` — the codebase runs
    // exactOptionalPropertyTypes, under which those are different types, and the absent-key form is
    // what production actually produces (the seam is spread in only when it is wired).
    const { agents: _omitted, ...withoutAgents } = agentsContext(okInvoke);
    const res = await dispatchWriteRoute(agentReq("/v1/agents/expert"), withoutAgents);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "agents_disabled" });
  });

  it("audits every refusal, not only the auth failures", async () => {
    // The clip and brief handlers record their 400 validation refusals too, so the agent route
    // matching only its 401/403 would have left an owner blind to a caller enumerating agent names
    // or hammering a saturated run store.
    const cases: Array<{ invoke: AgentHttpInvoker; code: number; reason: string }> = [
      {
        invoke: async () => ({ ok: false, reason: "unknown_agent" }),
        code: 404,
        reason: "unknown_agent",
      },
      {
        invoke: async () => ({
          ok: false,
          reason: "busy",
          activeRuns: 3,
          oldestExpiresInSeconds: null,
        }),
        code: 429,
        reason: "busy",
      },
      {
        invoke: async () => ({ ok: false, reason: "invalid_params", detail: "bad" }),
        code: 400,
        reason: "invalid_params",
      },
    ];
    for (const c of cases) {
      const ctx = agentsContext(c.invoke);
      await dispatchWriteRoute(agentReq("/v1/agents/expert"), ctx);
      const rows = ctx.writeDb
        .query("SELECT action_json FROM audit_log ORDER BY id DESC LIMIT 1")
        .all() as Array<{ action_json: string }>;
      const parsed = JSON.parse(rows[0]?.action_json ?? "{}") as {
        result_code: number;
        reason: string;
      };
      expect({ code: parsed.result_code, reason: parsed.reason }).toEqual({
        code: c.code,
        reason: c.reason,
      });
    }
  });

  it("405s every non-POST method on the invoke path rather than falling through", async () => {
    // GET is the method a reader most expects here, since the two agent READ routes live under
    // /v1/agents — but they are matched in the fetch handler, so a GET that reaches this dispatcher
    // must not silently fall through to something else. PUT and DELETE cover the other write verbs
    // dispatchWriteRoute accepts.
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const req = new Request("http://127.0.0.1/v1/agents/expert", { method });
      const res = await dispatchWriteRoute(req, agentsContext(okInvoke));
      expect({ method, status: res.status }).toEqual({ method, status: 405 });
      expect(res.headers.get("Allow")).toBe("POST");
    }
  });

  it("does not match a path with extra segments or a non-alpha name", async () => {
    for (const path of ["/v1/agents", "/v1/agents/expert/extra", "/v1/agents/ex-pert"]) {
      const res = await dispatchWriteRoute(agentReq(path), agentsContext(okInvoke));
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
  });
});

// --- POST /v1/items/fetch (I13 write surface) ----------------------------------------------
//
// Exercised through `dispatchWriteRoute` with a FAKE FetchWriteSurface rather than a real
// targetedFetch/server — the property under test is the route wiring — auth, scope, the
// missing_url 400, and 200-for-every-outcome — not the fetch-host-boundary/connector machinery,
// which has its own suite (sync/targeted-fetch.test.ts, sync/fetch-host-boundary.test.ts). The
// end-to-end path (real server, real scope enforcement) gets its own suite at
// test/integration/http/items-fetch-route.test.ts.

const FETCH_TOKEN = "fetch-route-token-0123456789abcdef0123456789ab";

function fetchContext(
  fetchItem: (url: string) => Promise<TargetedFetchOutcome>,
  scopes: readonly ApiScope[] = ["fetch"],
): WriteRouteContext {
  return {
    writeDb: openSeededInMemoryDb(45),
    expectedToken: "",
    rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    nowMs: () => 1_700_000_000_000,
    knownServices: (): readonly string[] => [],
    fetch: {
      verifyToken: async (presented: string) =>
        presented === FETCH_TOKEN ? { label: "chrome-work", scopes } : null,
      fetchItem,
    },
  };
}

function fetchReq(
  body: unknown = { url: "https://github.com/o/r/pull/1" },
  token: string | null = FETCH_TOKEN,
): Request {
  return new Request("http://127.0.0.1/v1/items/fetch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

const okIndexed: (url: string) => Promise<TargetedFetchOutcome> = async () => ({
  status: "indexed",
  itemId: "github:o/r#1",
});

describe("POST /v1/items/fetch", () => {
  it("returns 200 indexed for a fetch-scoped token", async () => {
    const res = await dispatchWriteRoute(fetchReq(), fetchContext(okIndexed));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "indexed", itemId: "github:o/r#1" });
  });

  it.each<TargetedFetchOutcome>([
    { status: "not_found", reason: "absent" },
    { status: "unsupported_url" },
    { status: "no_targeted_fetch", service: "jira" },
    { status: "not_configured" },
    { status: "not_configured", service: "jira" },
    { status: "rate_limited" },
  ])("returns 200 for the miss outcome %j — a miss is not a client error", async (outcome) => {
    const res = await dispatchWriteRoute(
      fetchReq(),
      fetchContext(async () => outcome),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(outcome);
  });

  it("passes the caller-supplied url through to fetchItem verbatim", async () => {
    const seenUrls: string[] = [];
    const capture = async (url: string): Promise<TargetedFetchOutcome> => {
      seenUrls.push(url);
      return { status: "indexed", itemId: "x" };
    };
    await dispatchWriteRoute(
      fetchReq({ url: "https://gitlab.com/o/r/-/merge_requests/1" }),
      fetchContext(capture),
    );
    expect(seenUrls).toEqual(["https://gitlab.com/o/r/-/merge_requests/1"]);
  });

  it("is 400 missing_url for a non-string url", async () => {
    const res = await dispatchWriteRoute(fetchReq({ url: 42 }), fetchContext(okIndexed));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_url" });
  });

  it("is 400 missing_url when the body has no url field at all", async () => {
    const res = await dispatchWriteRoute(fetchReq({}), fetchContext(okIndexed));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_url" });
  });

  it("is 401 for an unknown token, NOT 403", async () => {
    const res = await dispatchWriteRoute(
      fetchReq(undefined, "wrong-token"),
      fetchContext(okIndexed),
    );
    expect(res.status).toBe(401);
  });

  it("is 403 insufficient_scope for a resolve-only token — fetch is a distinct scope", async () => {
    const res = await dispatchWriteRoute(fetchReq(), fetchContext(okIndexed, ["resolve"]));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "insufficient_scope",
      required: "fetch",
      granted: ["resolve"],
    });
  });

  it("is 403 insufficient_scope for a legacy clip+briefs token", async () => {
    const res = await dispatchWriteRoute(fetchReq(), fetchContext(okIndexed, ["clip", "briefs"]));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope", required: "fetch" });
  });

  it("is 500 with a distinguishable audit reason when fetchItem throws — I29 fail-closed", async () => {
    const throwing = async (): Promise<TargetedFetchOutcome> => {
      throw new Error("egress_ledger append failed");
    };
    const ctx = fetchContext(throwing);
    const res = await dispatchWriteRoute(fetchReq(), ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    const rows = ctx.writeDb
      .query("SELECT action_json FROM audit_log ORDER BY id DESC LIMIT 1")
      .all() as Array<{ action_json: string }>;
    const parsed = JSON.parse(rows[0]?.action_json ?? "{}") as { reason: string };
    expect(parsed.reason).toBe("internal_error");
  });

  it("404s when the fetch seam is absent, naming the cause", async () => {
    // Built WITHOUT the key rather than with `fetch: undefined` — exactOptionalPropertyTypes makes
    // those different types, and the absent-key form is what production actually produces.
    const { fetch: _omitted, ...withoutFetch } = fetchContext(okIndexed);
    const res = await dispatchWriteRoute(fetchReq(), withoutFetch);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "fetch_disabled",
      hint: "targeted fetch disabled — no fetch-on-miss surface is wired",
    });
  });

  it("405s every non-POST method rather than falling through", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const req = new Request("http://127.0.0.1/v1/items/fetch", { method });
      const res = await dispatchWriteRoute(req, fetchContext(okIndexed));
      expect({ method, status: res.status }).toEqual({ method, status: 405 });
      expect(res.headers.get("Allow")).toBe("POST");
    }
  });

  it("413s a body over the 8 KiB control-plane cap — a URL is control-plane data, not an article", async () => {
    // A single URL is control-plane-sized: this route stays on MAX_BODY_BYTES_DEFAULT (8 KiB),
    // never the 1 MiB article cap `POST /v1/clips` / `POST /v1/briefs/{id}/sources` carry.
    const oversized = `https://github.com/o/r/pull/1?${"a".repeat(9 * 1024)}`;
    const res = await dispatchWriteRoute(fetchReq({ url: oversized }), fetchContext(okIndexed));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("audits the missing_url refusal, not only auth failures", async () => {
    const ctx = fetchContext(okIndexed);
    await dispatchWriteRoute(fetchReq({}), ctx);
    const rows = ctx.writeDb
      .query("SELECT action_json FROM audit_log ORDER BY id DESC LIMIT 1")
      .all() as Array<{ action_json: string }>;
    const parsed = JSON.parse(rows[0]?.action_json ?? "{}") as {
      result_code: number;
      reason: string;
    };
    expect({ code: parsed.result_code, reason: parsed.reason }).toEqual({
      code: 400,
      reason: "missing_url",
    });
  });
});

describe("ROUTE_ITEMS_FETCH constant", () => {
  test("is the exact allowlisted route string", () => {
    expect(ROUTE_ITEMS_FETCH).toBe("POST /v1/items/fetch");
    expect(WRITE_ROUTE_ALLOWLIST).toContain(ROUTE_ITEMS_FETCH);
  });
});
