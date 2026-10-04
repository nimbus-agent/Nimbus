/**
 * http-server-surfaces.test.ts
 *
 * `startReadOnlyHttpServer` assembles the I13 write dispatcher's dependency set PER REQUEST from
 * its options — the SCIM seam, the Teams surface, the agents seam — and the existing route suites
 * mostly drive `dispatchWriteRoute` directly, which never exercises that assembly. Every test here
 * goes through a real server (127.0.0.1, OS-assigned port), so what it proves is that an option
 * given to the server actually reaches the route.
 *
 * It also pins the read-side edges the route suites skip: unparseable `/v1/items` filters are
 * IGNORED (never "filter everything out"), the injected clock reaches the RPC reads, a malformed
 * `nimbus.toml` is the generic 500, a half-mounted status surface is not mounted at all, the admin
 * console serves and 404s real files, and `POST /v1/clips/related` survives a query with no
 * searchable terms and an `itemId` the index does not hold.
 *
 * No network beyond loopback; every DB is a copy of the migrated template in a fresh temp dir.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentHttpInvoker } from "../agent-runs/agent-http-invoke.ts";
import { AgentRunController } from "../agent-runs/agent-run-store.ts";
import { applyWritablePragmas } from "../db/writable-pragmas.ts";
import { materializeMigratedDb } from "../index/migrated-db-template.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { StatusReaders } from "./admin-status-rpc.ts";
import {
  type ReadOnlyHttpServerHandle,
  type ReadOnlyHttpServerOptions,
  startReadOnlyHttpServer,
} from "./http-server.ts";
import type { TeamsEventsSurface } from "./http-write-routes.ts";
import { createSeededTokenVault } from "./test-token-vault.ts";

const TOKEN = "surfaces-full-token-0123456789abcdef0123456789ab";

function tokenVault(): NimbusVault {
  return createSeededTokenVault(
    JSON.stringify({
      full: { token: TOKEN, scopes: ["clip", "briefs", "agents", "resolve", "fetch", "egress"] },
    }),
  );
}

const STATUS_READERS: StatusReaders = {
  policyState: () => ({ signatureValid: true, pendingRestart: false, source: "none" }),
  peers: () => [],
  connectors: () => [],
  namespaces: () => [],
  audit: () => ({ chainLength: 0, lastHash: "", appendRate1h: 0 }),
  hitl: () => ({ pendingApprovals: 0, pendingQuorum: 0 }),
  identity: () => ({ operatorValid: true }),
  syncFreshnessMs: () => 0,
};

const handles: ReadOnlyHttpServerHandle[] = [];
const dirs: string[] = [];
const ENV_DIST = "NIMBUS_ADMIN_CONSOLE_DIST";
let prevDist: string | undefined;

beforeEach(() => {
  // Read per request by the server, so a test that sets it must restore exactly what it found.
  prevDist = process.env[ENV_DIST];
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  if (prevDist === undefined) delete process.env[ENV_DIST];
  else process.env[ENV_DIST] = prevDist;
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* a leaked temp dir is the accepted trade-off on Windows (#972) */
    }
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * A real server over a fresh migrated index. `seed` runs on a writable connection BEFORE the
 * server opens its read-only handle; `toml`, when given, becomes the server's `nimbus.toml`.
 */
function serve(
  opts: ReadOnlyHttpServerOptions = {},
  extras: { readonly toml?: string; readonly seed?: (db: Database) => void } = {},
): string {
  const dir = tempDir("nimbus-http-surfaces-");
  const dbPath = join(dir, "nimbus.db");
  materializeMigratedDb(dbPath);
  // WAL before the server opens anything, as on a real index — see http-read-gates.test.ts for the
  // macOS SQLITE_CANTOPEN race a write-seam server otherwise hits under its own read handle.
  const setup = new Database(dbPath);
  try {
    applyWritablePragmas(setup);
    extras.seed?.(setup);
  } finally {
    setup.close();
  }
  if (extras.toml !== undefined) writeFileSync(join(dir, "nimbus.toml"), extras.toml);
  const handle = startReadOnlyHttpServer(
    dbPath,
    0,
    extras.toml === undefined ? opts : { ...opts, configDir: dir },
  );
  handles.push(handle);
  return `http://127.0.0.1:${String(handle.port)}`;
}

function seedItem(
  db: Database,
  item: { readonly id: string; readonly type: string; readonly title: string },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url,
                       modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?, 'github', ?, ?, ?, 'preview', NULL, NULL, 1000, NULL, NULL, 2000, 0)`,
    [item.id, item.type, item.id, item.title],
  );
}

async function itemIds(base: string, query: string): Promise<string[]> {
  const res = await fetch(`${base}/v1/items${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<{ id: string }> };
  return body.data.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// GET /v1/items — filter parsing
// ---------------------------------------------------------------------------

describe("GET /v1/items — an unparseable filter is ignored, never applied as nonsense", () => {
  test("since / sinceMs / untilMs: garbage widens to no filter; a real value filters", async () => {
    const base = serve({}, { seed: (db) => seedItem(db, { id: "gh:1", type: "pr", title: "A" }) });
    // modified_at is 1000 (1970): every real lower bound excludes it, every real upper bound
    // below 1000 excludes it — so each control below proves the parameter is otherwise live.
    expect(await itemIds(base, "?since=7d")).toEqual([]);
    expect(await itemIds(base, "?since=fortnight-ish")).toEqual(["gh:1"]);
    expect(await itemIds(base, "?sinceMs=5000")).toEqual([]);
    expect(await itemIds(base, "?sinceMs=not-a-number")).toEqual(["gh:1"]);
    expect(await itemIds(base, "?untilMs=500")).toEqual([]);
    expect(await itemIds(base, "?untilMs=not-a-number")).toEqual(["gh:1"]);
  });

  test("type: an empty ?type= is no type filter; a named type filters", async () => {
    const base = serve({}, { seed: (db) => seedItem(db, { id: "gh:1", type: "pr", title: "A" }) });
    expect(await itemIds(base, "?type=")).toEqual(["gh:1"]);
    expect(await itemIds(base, "?type=pr")).toEqual(["gh:1"]);
    expect(await itemIds(base, "?type=issue")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The RPC reads: clock, missing config dir, malformed config
// ---------------------------------------------------------------------------

describe("metrics / preflight reads — options reach the dispatcher", () => {
  test("the injected clock stamps computed_at; with no config dir every service is unknown", async () => {
    const base = serve({ nowMs: () => Date.UTC(2026, 0, 2) });
    const res = await fetch(`${base}/v1/preflight/deploy?service=api&target_ref=main`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      computed_at: string;
      verdict: string;
      checks: Record<string, { gap?: string }>;
    };
    expect(body.computed_at).toBe("2026-01-02T00:00:00.000Z");
    expect(body.verdict).toBe("warn");
    expect(body.checks["failing_ci_runs"]?.gap).toBe("unknown_service");
  });

  test("a malformed nimbus.toml is the generic 500 — the parser's message is not echoed", async () => {
    const base = serve(
      {},
      {
        toml: `[metrics.dora.super-secret-service]
repos = ["github:acme/payments"]
deploy_environments = ["staging-EU!"]
`,
      },
    );
    const res = await fetch(`${base}/v1/metrics/dora?service=super-secret-service`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal_error" });
    expect(text).not.toContain("super-secret-service");
    expect(text).not.toContain("staging-EU");
  });
});

// ---------------------------------------------------------------------------
// Admin: half-mounted status surface; the console's real files
// ---------------------------------------------------------------------------

describe("admin surface — mounting and the console's assets", () => {
  test("statusReaders WITHOUT an admin token is not a mounted surface: both routes 404", async () => {
    const base = serve({ statusReaders: STATUS_READERS });
    for (const path of ["/v1/admin/status", "/metrics"]) {
      const res = await fetch(`${base}${path}`, { headers: { authorization: "Bearer anything" } });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      await res.arrayBuffer();
    }
  });

  test("the console serves a built file with its content type, and 404s one it does not have", async () => {
    const dist = tempDir("nimbus-console-dist-");
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>console</title>");
    writeFileSync(join(dist, "app.js"), "console.log('admin');");
    process.env[ENV_DIST] = dist;
    const base = serve({
      statusReaders: STATUS_READERS,
      resolveAdminToken: () => Promise.resolve("admin-token"),
    });
    const auth = { headers: { authorization: "Bearer admin-token" } };

    const index = await fetch(`${base}/admin`, auth);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toBe("<!doctype html><title>console</title>");

    const script = await fetch(`${base}/admin/app.js`, auth);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toBe("console.log('admin');");

    const missing = await fetch(`${base}/admin/missing.css`, auth);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not Found");
  });
});

// ---------------------------------------------------------------------------
// Write seams assembled per request: SCIM, Teams, agents
// ---------------------------------------------------------------------------

describe("write seams — an option given to the server reaches its route", () => {
  test("SCIM: a provisioning write lands, and the bearer-checked roster read sees it", async () => {
    const base = serve({ resolveScimToken: () => Promise.resolve("scim-token") });
    const scimAuth = { authorization: "Bearer scim-token", "content-type": "application/json" };

    const created = await fetch(`${base}/scim/v2/Users`, {
      method: "POST",
      headers: scimAuth,
      body: JSON.stringify({ externalId: "u-1", userName: "alice" }),
    });
    expect(created.status).toBe(201);
    await created.arrayBuffer();

    const roster = await fetch(`${base}/scim/v2/Users`, { headers: scimAuth });
    expect(roster.status).toBe(200);
    expect(await roster.json()).toMatchObject({ totalResults: 1 });
  });

  test("Teams: a mounted surface handles the activity; a resolver that yields none is 404", async () => {
    const handled: unknown[] = [];
    const surface: TeamsEventsSurface = {
      teamsBotAppId: "app-1",
      validateBotJwt: async (header) => header === "Bearer good-jwt",
      onActivity: async (activity) => {
        handled.push(activity);
      },
    };
    const mounted = serve({ resolveTeamsEventsSurface: () => Promise.resolve(surface) });
    const res = await fetch(`${mounted}/v1/messaging/teams/events`, {
      method: "POST",
      headers: { authorization: "Bearer good-jwt", "content-type": "application/json" },
      body: JSON.stringify({ type: "message", text: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(handled).toEqual([{ type: "message", text: "hi" }]);

    const unmounted = serve({ resolveTeamsEventsSurface: () => Promise.resolve(undefined) });
    const refused = await fetch(`${unmounted}/v1/messaging/teams/events`, {
      method: "POST",
      headers: { authorization: "Bearer good-jwt", "content-type": "application/json" },
      body: JSON.stringify({ type: "message" }),
    });
    expect(refused.status).toBe(404);
    await refused.arrayBuffer();
    expect(handled).toHaveLength(1);
  });

  test("agents: invoking needs the run store AND the invoker; with both, the verified label is passed", async () => {
    const calls: Array<readonly [string, unknown, string]> = [];
    const invoke: AgentHttpInvoker = async (agent, params, label) => {
      calls.push([agent, params, label]);
      return { ok: true, runId: "expert_42" };
    };
    const request = {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ topic: "billing" }),
    };

    const noInvoker = serve({
      clipsVault: tokenVault(),
      agentRuns: new AgentRunController({ nowMs: () => 1_000 }),
    });
    const a = await fetch(`${noInvoker}/v1/agents/expert`, request);
    expect(a.status).toBe(404);
    expect(await a.json()).toMatchObject({ error: "agents_disabled" });

    const noRuns = serve({ clipsVault: tokenVault(), agentInvoke: invoke });
    const b = await fetch(`${noRuns}/v1/agents/expert`, request);
    expect(b.status).toBe(404);
    expect(await b.json()).toMatchObject({ error: "agents_disabled" });
    expect(calls).toEqual([]);

    const both = serve({
      clipsVault: tokenVault(),
      agentRuns: new AgentRunController({ nowMs: () => 1_000 }),
      agentInvoke: invoke,
    });
    const c = await fetch(`${both}/v1/agents/expert`, request);
    expect(c.status).toBe(202);
    expect(await c.json()).toEqual({ runId: "expert_42" });
    expect(calls).toEqual([["expert", { topic: "billing" }, "full"]]);
  });

  test("a finished agent run reports its synthesis provenance once one lands", async () => {
    const agentRuns = new AgentRunController({ nowMs: () => 1_000 });
    agentRuns.observe("agents.expert.briefReady", {
      sessionId: "expert_7",
      brief: "# Expert",
      findings: { people: 2 },
      synthesis: { attempted: false, reason: "synthesis_off" },
    });
    const base = serve({ clipsVault: tokenVault(), agentRuns });
    const res = await fetch(`${base}/v1/agents/runs/expert_7`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "done",
      brief: "# Expert",
      findings: { people: 2 },
      synthesis: { attempted: false, reason: "synthesis_off" },
    });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/clips/related — the FTS adapter's edges
// ---------------------------------------------------------------------------

describe("POST /v1/clips/related — the FTS adapter", () => {
  async function related(base: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${base}/v1/clips/related`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  function seeded(): string {
    return serve(
      { clipsVault: tokenVault() },
      {
        seed: (db) => {
          seedItem(db, { id: "gh:9", type: "pr", title: "roadmap review" });
          seedItem(db, { id: "gh:10", type: "issue", title: "roadmap review notes" });
        },
      },
    );
  }

  function ids(out: { body: unknown }): string[] {
    return ((out.body as { items: Array<{ id: string }> }).items ?? []).map((i) => i.id).sort();
  }

  test("punctuation-only text is phrase-quoted, so it matches nothing instead of a 500", async () => {
    const base = seeded();
    // Unquoted, `!!!` and `"` are FTS5 syntax errors — the route would answer 500.
    expect(await related(base, { title: '!!! "unbalanced ...' })).toEqual({
      status: 200,
      body: { items: [] },
    });
    // Control: a real term does reach the index.
    expect(ids(await related(base, { title: "roadmap" }))).toEqual(["gh:10", "gh:9"]);
  });

  test("an itemId the index HOLDS supplies the query from its title and is dropped from its own results", async () => {
    const base = seeded();
    // No `title` in the request: the query text can only have come from the looked-up row.
    const out = await related(base, { itemId: "gh:9" });
    expect(out.status).toBe(200);
    expect(ids(out)).toEqual(["gh:10"]);
  });

  test("an itemId the index does not hold falls back to the caller's title and excludes nothing", async () => {
    const base = seeded();
    const out = await related(base, { itemId: "nimbus:not-indexed", title: "roadmap review" });
    expect(out.status).toBe(200);
    expect(ids(out)).toEqual(["gh:10", "gh:9"]);
  });
});
