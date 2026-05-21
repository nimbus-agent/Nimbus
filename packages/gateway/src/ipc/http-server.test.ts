/**
 * Tier-B coverage for `startReadOnlyHttpServer` lifecycle scaffolding.
 *
 * The 65.12% baseline already came from three route-targeted integration
 * tests (`openapi-route.test.ts`, `metrics-dora-route.test.ts`,
 * `deployments-post-route.test.ts`, `preflight-deploy-route.test.ts`). The
 * uncovered slice was lifecycle scaffolding — the `Bun.serve` boundary, the
 * 405/404 dispatcher arms (POST without write surface, PUT/DELETE with and
 * without write surface, GET on a known POST path, GET on an unknown path),
 * the POST → `dispatchWriteRoute` arm, the `resolveDeploymentToken`
 * exception → generic 500 branch, the simple read-only routes for
 * `/v1/health`, `/v1/items`, `/v1/connectors`, `/v1/people`, and
 * `/v1/audit` (none of which were exercised by the existing route tests),
 * and the `stop()` cleanup arms (with and without `writeDb`).
 *
 * Each test uses `port = 0` so the OS picks a free port; this matches the
 * precedent set by `openapi-route.test.ts` and avoids random-port collision
 * flake on shared CI runners.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { startReadOnlyHttpServer } from "./http-server.ts";

function makeEmptyDb(dbPath: string, targetVersion = 28): void {
  const db = new Database(dbPath);
  runIndexedSchemaMigrations(db, targetVersion);
  db.close();
}

describe("startReadOnlyHttpServer — lifecycle and dispatcher arms", () => {
  let tmpDir: string;
  let dbPath: string;
  let handle: ReturnType<typeof startReadOnlyHttpServer> | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-http-server-lifecycle-"));
    dbPath = join(tmpDir, "nimbus.db");
    makeEmptyDb(dbPath);
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  it("binds an OS-assigned port when port = 0", () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.port).toBeLessThan(65536);
  });

  it("POST returns 405 with Allow: GET when no write surface is mounted", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    // Drain body so the connection can close cleanly.
    await res.text();
  });

  it("PUT returns 405 with Allow: GET, POST when write surface IS mounted", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => "test-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/items`, {
      method: "PUT",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, POST");
    await res.text();
  });

  it("DELETE returns 405 with Allow: GET when no write surface is mounted", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/items`, {
      method: "DELETE",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    await res.text();
  });

  it("GET on the write-only path /v1/deployments returns 405 with Allow: POST", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => "test-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/deployments`, {
      method: "GET",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    await res.text();
  });

  it("GET on an unknown path returns 404", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/no-such-path`);
    expect(res.status).toBe(404);
    await res.text();
  });

  it("POST to /v1/deployments reaches dispatchWriteRoute when the surface is mounted", async () => {
    // The actual auth / validation flow is exercised by
    // `deployments-post-route.test.ts`. Here we only assert that the
    // request reached the dispatcher — i.e. the response is NOT 405. With
    // no Authorization header the dispatcher will reject as 401, which
    // is the proof that we crossed the lifecycle boundary.
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => "test-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).not.toBe(405);
    expect(res.status).not.toBe(404);
    await res.text();
  });

  it("POST returns 500 internal_error when resolveDeploymentToken throws", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => {
        throw new Error("vault unavailable");
      },
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("internal_error");
  });
});

describe("startReadOnlyHttpServer — simple read-only routes", () => {
  let tmpDir: string;
  let dbPath: string;
  let handle: ReturnType<typeof startReadOnlyHttpServer> | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-http-server-routes-"));
    dbPath = join(tmpDir, "nimbus.db");
    const db = new Database(dbPath);
    runIndexedSchemaMigrations(db, 28);
    // Seed one row in each table so the route handlers actually execute
    // their result-shaping branches.
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url,
                         canonical_url, modified_at, author_id, metadata,
                         synced_at, pinned)
       VALUES ('github:pr_1', 'github', 'pr', 'pr_1', 'Hello',
               'preview', NULL, NULL, 1000, NULL, NULL, 2000, 0)`,
    );
    db.run(
      `INSERT INTO person (id, display_name, canonical_email,
                           github_login, gitlab_login, slack_handle,
                           linear_member_id, jira_account_id, notion_user_id,
                           metadata, linked)
       VALUES ('person:1', 'Alice', 'alice@example.com',
               NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1)`,
    );
    db.run(
      `INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp)
       VALUES ('test.action', 'not_required', '{"k":"v"}', 1000)`,
    );
    db.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token,
                               health_state, retry_after, backoff_until,
                               backoff_attempt, last_error)
       VALUES ('github', 1000, NULL, 'healthy', NULL, NULL, 0, NULL)`,
    );
    db.close();
    handle = startReadOnlyHttpServer(dbPath, 0);
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  it("GET /v1/health returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; gateway: string };
    expect(body.status).toBe("ok");
    expect(body.gateway).toBe("read_only_http");
  });

  it("GET /v1/items returns the seeded row", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/items?service=github`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { total: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /v1/items honours limit and since-window query params", async () => {
    // Exercise `parsePositiveInt` (limit) + `parseItemsListTimeFilters`
    // (since + sinceMs + untilMs).
    const url = `http://127.0.0.1:${handle!.port}/v1/items?limit=5&since=30d&untilMs=999999999999`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { limit: number } };
    expect(body.meta.limit).toBe(5);
  });

  it("GET /v1/items honours sinceMs numeric param", async () => {
    const url = `http://127.0.0.1:${handle!.port}/v1/items?sinceMs=0`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    await res.json();
  });

  it("GET /v1/items/:id returns the seeded row", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/items/github:pr_1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> | null };
    expect(body.data).not.toBeNull();
  });

  it("GET /v1/items/ (trailing slash, empty id) returns 400 missing id", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/items/`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("missing id");
  });

  it("GET /v1/connectors returns the seeded sync_state row", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/connectors`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { total: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.total).toBeGreaterThanOrEqual(1);
  });

  it("GET /v1/people returns the seeded person", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/people`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /v1/people/:id returns the seeded person", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/people/person:1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> | null };
    expect(body.data).not.toBeNull();
  });

  it("GET /v1/people/ (empty id) returns 400 missing id", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/people/`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("missing id");
  });

  it("GET /v1/audit returns the seeded row", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/audit?limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { limit: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.limit).toBe(10);
  });
});

describe("startReadOnlyHttpServer — cleanup", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-http-server-cleanup-"));
    dbPath = join(tmpDir, "nimbus.db");
    makeEmptyDb(dbPath);
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  it("stop() can be called multiple times without throwing (no write surface)", () => {
    const handle = startReadOnlyHttpServer(dbPath, 0);
    expect(() => handle.stop()).not.toThrow();
    expect(() => handle.stop()).not.toThrow();
  });

  it("stop() closes the write handle when the write surface is mounted", () => {
    // Both branches of the `if (writeDb !== null)` cleanup arm get exercised
    // by this pair of tests — the no-write-surface test above covers the
    // skip-branch, and this one covers the close-branch.
    const handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => "test-token",
    });
    expect(() => handle.stop()).not.toThrow();
    // Second stop() must also be a no-op — the inner try/catch swallows
    // any "already closed" errors so callers don't have to track state.
    expect(() => handle.stop()).not.toThrow();
  });
});
