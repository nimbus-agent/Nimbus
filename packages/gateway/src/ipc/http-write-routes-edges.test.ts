/**
 * http-write-routes-edges.test.ts
 *
 * The refusal arms of the I13 write dispatcher that `http-write-routes.test.ts` does not reach.
 * Every arm past route resolution both ANSWERS (a status and body the client keys on) and RECORDS
 * (a `*_rejected` audit row — the only trace an owner has of a refused external attempt), so each
 * of those tests asserts both halves: an arm that answered correctly but stopped auditing would be
 * a silent loss of exactly the evidence I13's audit-on-rejection exists to keep. The 405/404
 * routing refusals are the exception, and are asserted on the answer alone: they are decided
 * before any route resolves, so there is no route — and no reject action — to audit them under.
 *
 * Faults are injected through real seams, not mocks: a request body stream that errors, bytes
 * that are not UTF-8, a SQLite trigger that fails the `item` insert, a SCIM identity proxy, and
 * surfaces whose closures throw.
 */

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { openSeededInMemoryDb } from "../../test/helpers/migrated-db-seed.ts";
import { BriefRunController, type CreateResult } from "../briefs/brief-run-store.ts";
import type { ApiScope } from "../clips/api-scopes.ts";
import { PairingWindowController } from "../clips/pairing-window.ts";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { IdentityStore } from "../identity/identity-store.ts";
import { ScimError } from "../identity/scim-service.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { HttpWriteRateLimiter } from "./http-rate-limit.ts";
import {
  type BriefsWriteSurface,
  type ClipsWriteSurface,
  dispatchWriteRoute,
  type WriteRouteContext,
} from "./http-write-routes.ts";

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function migratedDb(): Database {
  const db = openSeededInMemoryDb(CURRENT_SCHEMA_VERSION);
  openDbs.push(db);
  return db;
}

function baseCtx(over: Partial<WriteRouteContext> = {}): WriteRouteContext {
  return {
    writeDb: migratedDb(),
    expectedToken: "deploy-token",
    rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    nowMs: () => 1_700_000_000_000,
    knownServices: () => ["api"],
    ...over,
  };
}

/** The `{result_code, reason}` of every rejection audited under `actionType`, oldest first. */
function rejections(
  db: Database,
  actionType: string,
): Array<{ result_code: number; reason: string }> {
  return db
    .query<{ action_json: string }, [string]>(
      "SELECT action_json FROM audit_log WHERE action_type = ? ORDER BY id",
    )
    .all(actionType)
    .map((r) => {
      const j = JSON.parse(r.action_json) as { result_code: number; reason: string };
      return { result_code: j.result_code, reason: j.reason };
    });
}

function post(path: string, body: RequestInit["body"], token?: string, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return new Request(`http://127.0.0.1${path}`, { method, headers, body });
}

// ---------------------------------------------------------------------------
// parseBody: the body cannot be read, or is not JSON
// ---------------------------------------------------------------------------

describe("parseBody — an unreadable or non-JSON body is refused and audited", () => {
  test("a body stream that errors mid-read is 400 invalid_body", async () => {
    const ctx = baseCtx();
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection reset by peer"));
      },
    });
    const res = await dispatchWriteRoute(post("/v1/deployments", broken, "deploy-token"), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(rejections(ctx.writeDb, "deployment.annotation_rejected")).toEqual([
      { result_code: 400, reason: "invalid_body" },
    ]);
  });

  test("a body that is not JSON is 400 invalid_json", async () => {
    const ctx = baseCtx();
    const res = await dispatchWriteRoute(
      post("/v1/deployments", "service=api&sha=abc", "deploy-token"),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expect(rejections(ctx.writeDb, "deployment.annotation_rejected")).toEqual([
      { result_code: 400, reason: "invalid_json" },
    ]);
  });

  test("bytes that are not valid UTF-8 are invalid_json too — the decoder is fatal", async () => {
    const ctx = baseCtx();
    // `{"a":` followed by a lone continuation byte: lenient decoding would turn it into U+FFFD.
    const bytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
    const res = await dispatchWriteRoute(post("/v1/deployments", bytes, "deploy-token"), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expect(rejections(ctx.writeDb, "deployment.annotation_rejected")).toEqual([
      { result_code: 400, reason: "invalid_json" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// runDeploymentRoute: a failure that is not the validator's
// ---------------------------------------------------------------------------

describe("POST /v1/deployments — an internal annotate failure", () => {
  test("a storage fault is 500 internal_error, audited, and stores nothing", async () => {
    const ctx = baseCtx();
    // A real SQLite failure inside annotateDeployment's transaction, raised by the database itself
    // rather than by a stubbed function: not an AnnotateError, so not the caller's fault.
    ctx.writeDb.run(
      "CREATE TRIGGER deny_item_insert BEFORE INSERT ON item BEGIN SELECT RAISE(ABORT, 'simulated storage fault'); END;",
    );
    const res = await dispatchWriteRoute(
      post(
        "/v1/deployments",
        JSON.stringify({
          service: "api",
          provider: "github-actions",
          environment: "production",
          sha: "abcdef1",
          ref: "main",
          status: "success",
          started_at_ms: 1_700_000_000_000 - 60_000,
        }),
        "deploy-token",
      ),
      ctx,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(rejections(ctx.writeDb, "deployment.annotation_rejected")).toEqual([
      { result_code: 500, reason: "internal_error" },
    ]);
    const stored = ctx.writeDb
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM item WHERE type = 'deployment'")
      .get();
    expect(stored?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Clip routes: wrong method, unmounted surface, and an out-of-scope token
// ---------------------------------------------------------------------------

function clipsSurface(scopes: readonly ApiScope[], ingested: unknown[]): ClipsWriteSurface {
  return {
    pairing: new PairingWindowController({ nowMs: () => 1_000, genCode: () => "123456" }),
    verifyToken: async (t) => (t === "good-token" ? { label: "chrome", scopes } : null),
    mintToken: async () => "minted",
    ingest: (input) => {
      ingested.push(input);
      return { id: "nimbus:clip:x", status: "created" };
    },
  };
}

describe("clip routes — method, mount and scope gates", () => {
  test("a non-POST to /v1/clips is 405 Allow: POST even with the surface mounted", async () => {
    const res = await dispatchWriteRoute(
      post("/v1/clips", "{}", "good-token", "PUT"),
      baseCtx({ clips: clipsSurface(["clip"], []) }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  test("/v1/clips/pair/confirm is 405 for a non-POST and 404 when the surface is unmounted", async () => {
    const wrongMethod = await dispatchWriteRoute(
      new Request("http://127.0.0.1/v1/clips/pair/confirm", { method: "DELETE" }),
      baseCtx({ clips: clipsSurface(["clip"], []) }),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("POST");

    const unmounted = await dispatchWriteRoute(
      post("/v1/clips/pair/confirm", JSON.stringify({ code: "123456" })),
      baseCtx(),
    );
    expect(unmounted.status).toBe(404);
  });

  test("a valid token WITHOUT the clip scope is 403 insufficient_scope; nothing is ingested", async () => {
    const ingested: unknown[] = [];
    const ctx = baseCtx({ clips: clipsSurface(["resolve"], ingested) });
    const res = await dispatchWriteRoute(
      post(
        "/v1/clips",
        JSON.stringify({ url: "https://ex.com", title: "t", body: "b", capturedAt: 1 }),
        "good-token",
      ),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "insufficient_scope",
      required: "clip",
      granted: ["resolve"],
    });
    expect(ingested).toEqual([]);
    expect(rejections(ctx.writeDb, "clip.ingest_rejected")).toEqual([
      { result_code: 403, reason: "insufficient_scope" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// SCIM: a ScimError outside the three named statuses
// ---------------------------------------------------------------------------

describe("SCIM — an unclassified ScimError status", () => {
  test("keeps its own status on the wire and is audited as scim_error", async () => {
    const db = migratedDb();
    const identity = new IdentityStore(db);
    const failing = new Proxy(identity, {
      get(target, prop) {
        if (prop === "upsertScimUser") {
          return () => {
            throw new ScimError("precondition failed", 412);
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ctx = baseCtx({
      writeDb: db,
      scim: { token: "scim-secret", store: new NamespaceStore(db), identity: failing },
    });
    const res = await dispatchWriteRoute(
      post(
        "/scim/v2/Users",
        JSON.stringify({ externalId: "u1", userName: "alice" }),
        "scim-secret",
      ),
      ctx,
    );
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({ detail: "precondition failed", status: 412 });
    expect(rejections(db, "scim.provision_rejected")).toEqual([
      { result_code: 412, reason: "scim_error" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Policy + Teams: the closures behind the surface throw
// ---------------------------------------------------------------------------

describe("PUT /v1/admin/policy — an authoring fault", () => {
  test("an authorPolicy that throws is 500 internal_error, audited", async () => {
    let authored = 0;
    const ctx = baseCtx({
      policy: {
        token: "admin-token",
        authorPolicy: () => {
          authored++;
          return Promise.reject(new Error("anchor key unavailable"));
        },
      },
    });
    const res = await dispatchWriteRoute(
      post("/v1/admin/policy", JSON.stringify({ toml: "org = 'acme'" }), "admin-token", "PUT"),
      ctx,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(authored).toBe(1);
    expect(rejections(ctx.writeDb, "policy.applied_rejected")).toEqual([
      { result_code: 500, reason: "internal_error" },
    ]);
  });
});

describe("POST /v1/messaging/teams/events — verifier and handler faults", () => {
  test("a JWT verifier that throws fails CLOSED to 401; the activity is never handled", async () => {
    const handled: unknown[] = [];
    const ctx = baseCtx({
      messaging: {
        teamsBotAppId: "app-1",
        validateBotJwt: () => Promise.reject(new Error("JWKS unreachable")),
        onActivity: async (a) => {
          handled.push(a);
        },
      },
    });
    const res = await dispatchWriteRoute(
      post("/v1/messaging/teams/events", JSON.stringify({ type: "message" }), "anything"),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(handled).toEqual([]);
    expect(rejections(ctx.writeDb, "messaging.teams.inbound_rejected")).toEqual([
      { result_code: 401, reason: "invalid_bot_jwt" },
    ]);
  });

  test("an activity handler that throws is 500 internal_error, audited", async () => {
    const ctx = baseCtx({
      messaging: {
        teamsBotAppId: "app-1",
        validateBotJwt: async () => true,
        onActivity: () => Promise.reject(new Error("router crashed")),
      },
    });
    const res = await dispatchWriteRoute(
      post("/v1/messaging/teams/events", JSON.stringify({ type: "message" }), "anything"),
      ctx,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(rejections(ctx.writeDb, "messaging.teams.inbound_rejected")).toEqual([
      { result_code: 500, reason: "internal_error" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/briefs: a field-less validation error, and a controller fault
// ---------------------------------------------------------------------------

describe("POST /v1/briefs — validation vs internal failure", () => {
  function briefsSurface(controller: BriefRunController): BriefsWriteSurface {
    return {
      controller,
      verifyToken: async (t) =>
        t === "brief-token" ? { label: "chrome", scopes: ["clip", "briefs"] } : null,
      startRun: () => {},
      save: () => ({ itemId: "nimbus:research_brief:x" }),
    };
  }

  test("a body that is not an object is 400 invalid_request with NO field key", async () => {
    const ctx = baseCtx({
      briefs: briefsSurface(new BriefRunController({ nowMs: () => 1_000 })),
    });
    const res = await dispatchWriteRoute(
      post("/v1/briefs", JSON.stringify(["not", "an", "object"]), "brief-token"),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(rejections(ctx.writeDb, "brief.create_rejected")).toEqual([
      { result_code: 400, reason: "invalid_request" },
    ]);
  });

  test("a controller fault is 500 internal_error — never reported as the caller's bad request", async () => {
    class FaultyController extends BriefRunController {
      override create(): CreateResult {
        throw new Error("run registry corrupted");
      }
    }
    const ctx = baseCtx({ briefs: briefsSurface(new FaultyController({ nowMs: () => 1_000 })) });
    const res = await dispatchWriteRoute(
      post(
        "/v1/briefs",
        JSON.stringify({
          brief: "What changed?",
          sources: [{ url: "https://ex.com/a", title: "A" }],
          useIndex: false,
        }),
        "brief-token",
      ),
      ctx,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(rejections(ctx.writeDb, "brief.create_rejected")).toEqual([
      { result_code: 500, reason: "internal_error" },
    ]);
  });
});
