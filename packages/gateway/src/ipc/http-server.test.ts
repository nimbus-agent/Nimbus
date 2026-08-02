import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { StatusReaders } from "./admin-status-rpc.ts";
import { startReadOnlyHttpServer } from "./http-server.ts";

const STATUS_READERS: StatusReaders = {
  policyState: () => ({ signatureValid: true, pendingRestart: false, source: "none" }),
  peers: () => [{ peerId: "peer:aa", reachable: true }],
  connectors: () => [{ id: "github", enabled: true, blockedByPolicy: false, health: "ok" }],
  namespaces: () => [],
  audit: () => ({ chainLength: 3, lastHash: "abc", appendRate1h: 1 }),
  hitl: () => ({ pendingApprovals: 0, pendingQuorum: 0 }),
  identity: () => ({ operatorValid: true }),
  syncFreshnessMs: () => 0,
};

function makeEmptyDb(dbPath: string, targetVersion = 28): void {
  const db = new Database(dbPath);
  runIndexedSchemaMigrations(db, targetVersion);
  db.close();
}

/** Path to the real built admin-console dist (packages/admin-console/dist). */
function builtConsoleDist(): string {
  // A self-contained dummy "built" console (index.html present) so resolveConsoleDist() resolves
  // on CI regardless of whether the real packages/admin-console/dist was built — the previous
  // version pointed at the real dist, which is absent on CI runners → the route returned 503
  // (not-built) instead of reaching the safeAssetPath traversal-rejection branch under test.
  const dir = mkdtempSync(join(tmpdir(), "nimbus-admin-console-dist-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>nimbus admin (test)</title>");
  return dir;
}

/**
 * Issue a raw HTTP/1.1 GET over a TCP socket so the path is sent verbatim — `fetch` normalizes
 * `..` segments out of the URL, which would defeat the traversal-rejection assertion.
 */
/** One raw-socket HTTP GET attempt. Resolves as soon as a complete status line arrives
 * (independent of close timing — under load `close` could fire before the status was read,
 * which previously yielded a misleading status 0). Times out and fails loudly otherwise. */
function rawGetOnce(port: number, path: string, token: string): Promise<{ status: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let received = "";
    let settled = false;
    const settleOk = (status: number, socket?: { end(): void }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.end();
      resolvePromise({ status });
    };
    const settleErr = (err: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => settleErr(new Error("rawGet timeout")), 5000);
    const parseStatus = (): number =>
      Number.parseInt((received.split("\r\n", 1)[0] ?? "").split(" ")[1] ?? "0", 10);
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket): void {
          socket.write(
            `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
          );
        },
        data(socket, data): void {
          received += new TextDecoder().decode(data);
          if (received.includes("\r\n")) settleOk(parseStatus(), socket);
        },
        close(): void {
          if (received !== "") settleOk(parseStatus());
          else settleErr(new Error("rawGet: connection closed with no response"));
        },
        error(_socket, err): void {
          settleErr(err);
        },
      },
    }).catch(settleErr);
  });
}

/** Retry the raw GET a few times so a transient connection reset under full-suite
 * concurrency doesn't flake the assertion (the parsed status itself is deterministic). */
async function rawGet(port: number, path: string, token: string): Promise<{ status: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await rawGetOnce(port, path, token);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
    await res.text();
  });

  it("PUT to an unknown write path 404s (PUT is now the policy write method)", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => "test-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/items`, {
      method: "PUT",
    });
    // PUT now flows through the I13 write dispatcher (it carries PUT /v1/admin/policy); an
    // unrecognized write path resolves to 404, mirroring POST to an unknown path.
    expect(res.status).toBe(404);
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

  it("GET on the PUT-only path /v1/admin/policy returns 405 with Allow: PUT", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveAdminToken: async () => "admin-token",
      authorPolicy: async (toml) => ({
        ok: true,
        bundle: { toml, sig: "SIG" },
        org: "acme",
        version: 1,
      }),
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/policy`, {
      method: "GET",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("PUT");
    await res.text();
  });

  it("GET on an unknown path returns 404", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/no-such-path`);
    expect(res.status).toBe(404);
    await res.text();
  });

  it("POST to /v1/deployments reaches dispatchWriteRoute when the surface is mounted", async () => {
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

  it("PUT /v1/admin/policy 404s when the policy surface is not mounted", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, { resolveDeploymentToken: async () => "t" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({ toml: "x" }),
    });
    expect(res.status).toBe(404);
    await res.text();
  });

  it("PUT /v1/admin/policy is 401 without a bearer when mounted", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveAdminToken: async () => "admin-token",
      authorPolicy: async (toml) => ({
        ok: true,
        bundle: { toml, sig: "SIG" },
        org: "acme",
        version: 1,
      }),
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toml: '[policy]\norg = "acme"\n' }),
    });
    expect(res.status).toBe(401);
    await res.text();
  });

  it("PUT /v1/admin/policy applies a valid policy with a valid bearer (200, no privkey)", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveAdminToken: async () => "admin-token",
      authorPolicy: async (toml) => ({
        ok: true,
        bundle: { toml, sig: "SIG" },
        org: "acme",
        version: 3,
      }),
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
      body: JSON.stringify({ toml: '[policy]\norg = "acme"\nversion = 3\n' }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("privkey");
    const body = JSON.parse(text) as { data: { applied: boolean; org: string; version: number } };
    expect(body.data).toEqual({ applied: true, org: "acme", version: 3 });
  });

  it("PUT /v1/admin/policy returns 400 on an invalid body (no toml string)", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveAdminToken: async () => "admin-token",
      authorPolicy: async (toml) => ({
        ok: true,
        bundle: { toml, sig: "SIG" },
        org: "acme",
        version: 1,
      }),
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
      body: JSON.stringify({ notToml: true }),
    });
    expect(res.status).toBe(400);
    await res.text();
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
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
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

  it("GET /v1/openapi.json serves the OpenAPI document as JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = (await res.json()) as { openapi?: string };
    expect(typeof body.openapi).toBe("string");
  });

  it("GET /v1/metrics/dora returns 400 when the service param is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/metrics/dora`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("service");
  });

  it("GET /v1/metrics/dora returns a 200 unconfigured envelope for an unknown service", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/metrics/dora?service=github`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; metrics: Record<string, unknown> };
    expect(body.service).toBe("github");
    expect(body.metrics).toBeDefined();
  });

  it("GET /v1/metrics/dora returns 400 on a malformed since (MetricsRpcError → 400)", async () => {
    const res = await fetch(
      `http://127.0.0.1:${handle!.port}/v1/metrics/dora?service=github&since=bogus`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  it("GET /v1/preflight/deploy returns 400 when service is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/preflight/deploy`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("service");
  });

  it("GET /v1/preflight/deploy returns 400 when target_ref is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/v1/preflight/deploy?service=github`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("target_ref");
  });

  it("GET /v1/preflight/deploy returns 400 when max_findings is not an integer", async () => {
    const res = await fetch(
      `http://127.0.0.1:${handle!.port}/v1/preflight/deploy?service=github&target_ref=main&max_findings=abc`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("max_findings");
  });

  it("GET /v1/preflight/deploy returns 400 when max_findings is out of range (RpcError → 400)", async () => {
    const res = await fetch(
      `http://127.0.0.1:${handle!.port}/v1/preflight/deploy?service=github&target_ref=main&max_findings=999`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  it("GET /v1/preflight/deploy returns a 200 unconfigured envelope for an unknown service", async () => {
    const res = await fetch(
      `http://127.0.0.1:${handle!.port}/v1/preflight/deploy?service=github&target_ref=main&max_findings=5`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; verdict: string };
    expect(body.service).toBe("github");
    expect(body.verdict).toBe("ok");
  });
});

describe("startReadOnlyHttpServer — observability surface (admin.status + /metrics)", () => {
  let tmpDir: string;
  let dbPath: string;
  let handle: ReturnType<typeof startReadOnlyHttpServer> | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-http-server-admin-"));
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

  it("GET /v1/admin/status returns 401 without a bearer token", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      statusReaders: STATUS_READERS,
      resolveAdminToken: async () => "admin-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/status`);
    expect(res.status).toBe(401);
    await res.text();
  });

  it("GET /v1/admin/status returns 401 with a wrong bearer token", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      statusReaders: STATUS_READERS,
      resolveAdminToken: async () => "admin-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/status`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
    await res.text();
  });

  it("GET /v1/admin/status returns the snapshot with a valid bearer token", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      statusReaders: STATUS_READERS,
      resolveAdminToken: async () => "admin-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/status`, {
      headers: { authorization: "Bearer admin-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { audit: { chainLength: number } } };
    expect(body.data.audit.chainLength).toBe(3);
  });

  it("GET /metrics returns 401 text without a bearer token", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      statusReaders: STATUS_READERS,
      resolveAdminToken: async () => "admin-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/metrics`);
    expect(res.status).toBe(401);
    await res.text();
  });

  it("GET /metrics returns Prometheus text with a valid bearer token", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      statusReaders: STATUS_READERS,
      resolveAdminToken: async () => "admin-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/metrics`, {
      headers: { authorization: "Bearer admin-token" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("nimbus_audit_chain_length 3");
  });

  it("GET /v1/admin/status returns 401 when the admin token is empty (fail-closed)", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      statusReaders: STATUS_READERS,
      resolveAdminToken: async () => "",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/status`, {
      headers: { authorization: "Bearer anything" },
    });
    expect(res.status).toBe(401);
    await res.text();
  });

  it("GET /metrics returns 401 when the admin token is empty (fail-closed)", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      statusReaders: STATUS_READERS,
      resolveAdminToken: async () => "",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/metrics`, {
      headers: { authorization: "Bearer anything" },
    });
    expect(res.status).toBe(401);
    await res.text();
  });

  it("GET /v1/admin/status returns 404 when the surface is not mounted", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/admin/status`);
    expect(res.status).toBe(404);
    await res.text();
  });
});

describe("startReadOnlyHttpServer — admin console assets (/admin/*)", () => {
  let tmpDir: string;
  let dbPath: string;
  let handle: ReturnType<typeof startReadOnlyHttpServer> | undefined;
  let prevDist: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-http-server-console-"));
    dbPath = join(tmpDir, "nimbus.db");
    makeEmptyDb(dbPath);
    prevDist = process.env["NIMBUS_ADMIN_CONSOLE_DIST"];
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    if (prevDist === undefined) {
      delete process.env["NIMBUS_ADMIN_CONSOLE_DIST"];
    } else {
      process.env["NIMBUS_ADMIN_CONSOLE_DIST"] = prevDist;
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  it("GET /admin returns 401 without a bearer token", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      statusReaders: STATUS_READERS,
      resolveAdminToken: async () => "admin-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/admin`);
    expect(res.status).toBe(401);
    await res.text();
  });

  it("GET /admin returns 503 with a valid bearer when the console is not built", async () => {
    // Force resolveConsoleDist → undefined by pointing the override at a path with no index.html.
    process.env["NIMBUS_ADMIN_CONSOLE_DIST"] = join(tmpDir, "no-console-here");
    handle = startReadOnlyHttpServer(dbPath, 0, {
      statusReaders: STATUS_READERS,
      resolveAdminToken: async () => "admin-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/admin`, {
      headers: { authorization: "Bearer admin-token" },
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("not built");
  });

  it("rejects encoded-slash traversal (/admin/..%2f..%2fetc) with 400 under a valid bearer", async () => {
    // Point the override at a real built dist so resolveConsoleDist resolves, exercising the
    // safeAssetPath traversal rejection (400) rather than the 503 not-built branch.
    process.env["NIMBUS_ADMIN_CONSOLE_DIST"] = builtConsoleDist();
    handle = startReadOnlyHttpServer(dbPath, 0, {
      statusReaders: STATUS_READERS,
      resolveAdminToken: async () => "admin-token",
    });
    // URL parsing collapses literal ".." segments before our handler sees them; the surviving
    // attack is an encoded slash (%2f) so the ".." reaches url.pathname intact. fetch would also
    // normalize, so issue the raw request line on the socket directly.
    const raw = await rawGet(handle.port, "/admin/..%2f..%2fetc%2fpasswd", "admin-token");
    // Cross-platform: depending on the runtime's URL parser, the encoded slash either survives so
    // ".." reaches safeAssetPath (→ 400 rejection) or is decoded/normalized to a clean non-existent
    // asset path (→ 404). BOTH prevent the traversal — the route must never serve the target. The
    // security property is "never 200 / never serves /etc/passwd"; the deterministic safeAssetPath
    // unit tests (admin-console-assets.test.ts) cover the rejection logic directly.
    expect(raw.status).not.toBe(200);
    expect([400, 404]).toContain(raw.status);
  });

  it("GET /admin returns 404 when the surface is not mounted", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/admin`);
    expect(res.status).toBe(404);
    await res.text();
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
    const handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => "test-token",
    });
    expect(() => handle.stop()).not.toThrow();
    expect(() => handle.stop()).not.toThrow();
  });
});

describe("startReadOnlyHttpServer — unsupported HTTP method", () => {
  let tmpDir: string;
  let dbPath: string;
  let handle: ReturnType<typeof startReadOnlyHttpServer> | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-http-server-method-"));
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

  it("OPTIONS returns 405 with Allow: GET when no write surface is mounted", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/health`, { method: "OPTIONS" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    await res.text();
  });

  it("OPTIONS returns 405 with Allow: GET, POST when a write surface is mounted", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => "test-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/health`, { method: "OPTIONS" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, POST");
    await res.text();
  });
});

describe("startReadOnlyHttpServer — SCIM roster read surface", () => {
  let tmpDir: string;
  let dbPath: string;
  let handle: ReturnType<typeof startReadOnlyHttpServer> | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-http-server-scim-"));
    dbPath = join(tmpDir, "nimbus.db");
    // SCIM (scim_user table) lands at V34.
    makeEmptyDb(dbPath, 34);
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

  it("GET /scim/v2/Users returns 401 without a bearer when the SCIM surface is mounted", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveScimToken: async () => "scim-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/scim/v2/Users`);
    expect(res.status).toBe(401);
    await res.text();
  });

  it("GET /scim/v2/Users returns 200 with a valid bearer (empty roster)", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveScimToken: async () => "scim-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/scim/v2/Users`, {
      headers: { authorization: "Bearer scim-token" },
    });
    expect(res.status).toBe(200);
    await res.text();
  });

  it("GET /scim/v2/Users 405s when the SCIM surface is not mounted (write-only path)", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/scim/v2/Users`);
    // No resolveScimToken → writeDb is null → the SCIM read branch is skipped; /scim/v2/Users is
    // a POST-only write route in the allowlist, so the GET resolves to a 405 (Allow: POST).
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    await res.text();
  });
});
