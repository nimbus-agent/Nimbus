/**
 * The shared gates of `http-server.ts`, pinned across EVERY route that uses them, against a real
 * server: the scoped-read gate (surface mounted? then token scope), the admin bearer gate, the
 * required-query-param rule, the RPC-read error mapping, the run poll, and the exact bodies and
 * content types each one answers.
 *
 * The per-route suites assert most of this one route at a time. What only a table can assert is
 * that the gate answers IDENTICALLY for all of its callers — and two shapes no route suite builds:
 * a half-mounted briefs/agents surface (client-token vault present, run store absent), and a
 * status surface missing one of its two halves.
 *
 * DB-free where it can be: every refusal below is decided before the index is touched.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunController } from "../agent-runs/agent-run-store.ts";
import { BriefRunController } from "../briefs/brief-run-store.ts";
import type { ApiScope } from "../clips/api-scopes.ts";
import { applyWritablePragmas } from "../db/writable-pragmas.ts";
import { materializeMigratedDb } from "../index/migrated-db-template.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { StatusReaders } from "./admin-status-rpc.ts";
import * as routeAuth from "./http-route-auth.ts";
import {
  type ClipReadRouteKey,
  clipScopeFor,
  HTTP_ROUTE_AUTH,
  ROUTE_KEY_AGENT_RUN_GET,
  ROUTE_KEY_AGENTS_LIST,
  ROUTE_KEY_BRIEF_GET,
  ROUTE_KEY_CLIPS_RELATED,
  ROUTE_KEY_EGRESS_HEAD,
  ROUTE_KEY_EGRESS_LIST,
  ROUTE_KEY_EGRESS_PROVE,
  ROUTE_KEY_EGRESS_VERIFY,
  ROUTE_KEY_ITEMS_RESOLVE,
  ROUTE_KEY_ITEMS_RESOLVE_FILE,
  ROUTE_KEY_ITEMS_RESOLVE_IDS,
  ROUTE_KEY_SERVICES_RESOLVE,
} from "./http-route-auth.ts";
import {
  type ReadOnlyHttpServerHandle,
  type ReadOnlyHttpServerOptions,
  startReadOnlyHttpServer,
} from "./http-server.ts";
import { WRITE_ROUTE_ALLOWLIST } from "./http-write-routes.ts";
import { createSeededTokenVault } from "./test-token-vault.ts";

const FULL_TOKEN = "read-gates-full-token-0123456789abcdef0123456789";
/** Carries `fetch` only — a scope NO inline read requires, so every one of them must 403. */
const NARROW_TOKEN = "read-gates-narrow-token-0123456789abcdef01234567";
const BOGUS_TOKEN = "read-gates-not-a-real-token";
const ADMIN_TOKEN = "read-gates-admin-token";

/** An invalid regex: the loader throws a message that names the service AND the offending value. */
const MALFORMED_TOML = `[metrics.dora.secret-svc]\nrepos = ["github:acme/web"]\ndeploy_workflow_pattern = "["\n`;

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

function seededVault(): NimbusVault {
  return createSeededTokenVault(
    JSON.stringify({
      full: {
        token: FULL_TOKEN,
        scopes: ["clip", "briefs", "agents", "resolve", "fetch", "egress"],
      },
      narrow: { token: NARROW_TOKEN, scopes: ["fetch"] },
    }),
  );
}

/** A seeded vault that counts READS, so a test can prove a refusal came before any token lookup. */
function readCountingVault(): { readonly vault: NimbusVault; readonly reads: () => number } {
  const inner = seededVault();
  let reads = 0;
  const vault: NimbusVault = {
    get: (key) => {
      reads += 1;
      return inner.get(key);
    },
    set: (key, value) => inner.set(key, value),
    delete: (key) => inner.delete(key),
    listKeys: (prefix) => inner.listKeys(prefix),
  };
  return { vault, reads: () => reads };
}

const handles: ReadOnlyHttpServerHandle[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  for (const dir of dirs.splice(0)) {
    try {
      // maxRetries: 0 — a pinned handle must fail fast, never block the hook (#972, #973).
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* a leaked temp dir is the accepted trade-off */
    }
  }
});

/** A real server over a fresh migrated index; `toml`, when given, becomes its `nimbus.toml`. */
function serve(opts: ReadOnlyHttpServerOptions = {}, toml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-http-read-gates-"));
  dirs.push(dir);
  const dbPath = join(dir, "nimbus.db");
  materializeMigratedDb(dbPath);
  // WAL on the FILE before the server opens anything, as a real index has been since long before
  // any given gateway start. The template copy is rollback-journal, and a server mounting a write
  // seam (clipsVault, the run stores) flips it to WAL underneath its own already-open read-only
  // handle — which raced on macOS, failing that handle's next read with SQLITE_CANTOPEN (see
  // http-egress-routes.test.ts). The in-scope test reads the index through exactly that handle.
  const setup = new Database(dbPath);
  try {
    expect(applyWritablePragmas(setup)).toBe("wal");
  } finally {
    setup.close();
  }
  if (toml !== undefined) writeFileSync(join(dir, "nimbus.toml"), toml);
  const handle = startReadOnlyHttpServer(
    dbPath,
    0,
    toml === undefined ? opts : { ...opts, configDir: dir },
  );
  handles.push(handle);
  return `http://127.0.0.1:${String(handle.port)}`;
}

type ScopedRoute = {
  /** The `HTTP_ROUTE_AUTH` key the row exercises — what ties it to the table it is checked against. */
  readonly routeKey: ClipReadRouteKey;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly scope: ApiScope;
  /** The route's own answer when its surface is not mounted: a named JSON 404, or bare text. */
  readonly disabled: { readonly json: Record<string, string> } | { readonly text: string };
  /** What an in-scope token reaches on a fully mounted server: past the gate, into the route. */
  readonly admitted: { readonly status: 200 } | { readonly status: 404; readonly runMiss: true };
};

const RESOLVE_DISABLED = { json: { error: "resolve_disabled" } };
const EGRESS_DISABLED = { json: { error: "egress_disabled" } };
const BRIEFS_DISABLED = {
  json: {
    error: "briefs_disabled",
    hint: "research briefs disabled — enable [briefs] in nimbus.toml",
  },
};
const AGENTS_DISABLED = {
  json: {
    error: "agents_disabled",
    hint: "agent invocation over HTTP disabled — no local index is wired",
  },
};

/** Every bearer-scoped inline read the server mounts — one row per `ClipReadRouteKey`. */
const SCOPED_ROUTES: readonly ScopedRoute[] = [
  {
    routeKey: ROUTE_KEY_CLIPS_RELATED,
    method: "POST",
    path: "/v1/clips/related",
    scope: "clip",
    disabled: { text: "Not Found" },
    admitted: { status: 200 },
  },
  {
    routeKey: ROUTE_KEY_ITEMS_RESOLVE,
    method: "GET",
    path: "/v1/items/resolve?url=https%3A%2F%2Fexample.com%2Fa",
    scope: "resolve",
    disabled: RESOLVE_DISABLED,
    admitted: { status: 200 },
  },
  {
    routeKey: ROUTE_KEY_ITEMS_RESOLVE_FILE,
    method: "GET",
    path: "/v1/items/resolve-file?service=github&repo=acme%2Fweb&refAndPath=main%2Fa.ts",
    scope: "resolve",
    disabled: RESOLVE_DISABLED,
    admitted: { status: 200 },
  },
  {
    routeKey: ROUTE_KEY_ITEMS_RESOLVE_IDS,
    method: "GET",
    path: "/v1/items/resolve-ids?id=github%3Aweb%231",
    scope: "resolve",
    disabled: RESOLVE_DISABLED,
    admitted: { status: 200 },
  },
  {
    routeKey: ROUTE_KEY_SERVICES_RESOLVE,
    method: "GET",
    path: "/v1/services/resolve?repo=github%3Aacme%2Fweb",
    scope: "resolve",
    disabled: { json: { error: "services_disabled" } },
    admitted: { status: 200 },
  },
  {
    routeKey: ROUTE_KEY_EGRESS_LIST,
    method: "GET",
    path: "/v1/egress",
    scope: "egress",
    disabled: EGRESS_DISABLED,
    admitted: { status: 200 },
  },
  {
    routeKey: ROUTE_KEY_EGRESS_HEAD,
    method: "GET",
    path: "/v1/egress/head",
    scope: "egress",
    disabled: EGRESS_DISABLED,
    admitted: { status: 200 },
  },
  {
    routeKey: ROUTE_KEY_EGRESS_VERIFY,
    method: "GET",
    path: "/v1/egress/verify",
    scope: "egress",
    disabled: EGRESS_DISABLED,
    admitted: { status: 200 },
  },
  {
    routeKey: ROUTE_KEY_EGRESS_PROVE,
    method: "GET",
    path: "/v1/egress/prove",
    scope: "egress",
    disabled: EGRESS_DISABLED,
    admitted: { status: 200 },
  },
  {
    routeKey: ROUTE_KEY_BRIEF_GET,
    method: "GET",
    path: "/v1/briefs/run_unknown",
    scope: "briefs",
    disabled: BRIEFS_DISABLED,
    admitted: { status: 404, runMiss: true },
  },
  {
    routeKey: ROUTE_KEY_AGENTS_LIST,
    method: "GET",
    path: "/v1/agents",
    scope: "agents",
    disabled: AGENTS_DISABLED,
    admitted: { status: 200 },
  },
  {
    routeKey: ROUTE_KEY_AGENT_RUN_GET,
    method: "GET",
    path: "/v1/agents/runs/expert_1_unknown",
    scope: "agents",
    disabled: AGENTS_DISABLED,
    admitted: { status: 404, runMiss: true },
  },
];

const RUN_ROUTES = SCOPED_ROUTES.filter((r) => r.scope === "briefs" || r.scope === "agents");

function call(base: string, route: ScopedRoute, token?: string): Promise<Response> {
  const headers: Record<string, string> =
    token === undefined ? {} : { authorization: `Bearer ${token}` };
  if (route.method === "POST") {
    return fetch(`${base}${route.path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
  }
  return fetch(`${base}${route.path}`, { headers });
}

async function expectDisabled(res: Response, route: ScopedRoute): Promise<void> {
  expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 404 });
  if ("json" in route.disabled) {
    expect(await res.json()).toEqual(route.disabled.json);
  } else {
    expect(await res.text()).toBe(route.disabled.text);
  }
}

/** `"GET /v1/briefs/*"` → a matcher for the request path, `*` standing for ONE path segment. */
function routeKeyPathMatcher(pattern: string): RegExp {
  const literal = (s: string): string => s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`^${pattern.split("*").map(literal).join("[^/]+")}$`);
}

// Every assertion below is only as wide as SCOPED_ROUTES, so the table is derived-checked rather
// than trusted: a bearer-scoped read added to the server with no row here would otherwise sit
// outside all of them while this file stayed green. It is checked against the exported route
// keys, against HTTP_ROUTE_AUTH, and against the gate call sites in http-server.ts itself.
describe("the SCOPED_ROUTES table itself", () => {
  test("has exactly one row per exported ROUTE_KEY_* read — every clip-scoped read in HTTP_ROUTE_AUTH", () => {
    const exportedKeys: string[] = [];
    for (const [name, value] of Object.entries(routeAuth)) {
      if (name.startsWith("ROUTE_KEY_") && typeof value === "string") exportedKeys.push(value);
    }
    exportedKeys.sort();
    const clipReadKeys = Object.entries(HTTP_ROUTE_AUTH)
      .filter(([key, auth]) => auth.kind === "clip" && !WRITE_ROUTE_ALLOWLIST.includes(key))
      .map(([key]) => key)
      .sort();
    const rowKeys: string[] = SCOPED_ROUTES.map((route) => route.routeKey);

    expect(new Set(rowKeys).size).toBe(rowKeys.length);
    expect([...rowKeys].sort()).toEqual(exportedKeys);
    expect(clipReadKeys).toEqual(exportedKeys);
  });

  test("each row's method, path and scope are the ones its route key names", () => {
    type RowShape = {
      readonly routeKey: string;
      readonly method: string;
      readonly pathMatches: boolean;
      readonly scope: ApiScope | null;
    };
    for (const route of SCOPED_ROUTES) {
      const [method = "", pattern = ""] = route.routeKey.split(" ");
      const path = route.path.split("?")[0] ?? "";
      const actual: RowShape = {
        routeKey: route.routeKey,
        method: route.method,
        pathMatches: routeKeyPathMatcher(pattern).test(path),
        scope: route.scope,
      };
      const expected: RowShape = {
        routeKey: route.routeKey,
        method,
        pathMatches: true,
        scope: clipScopeFor(route.routeKey),
      };
      expect(actual).toEqual(expected);
    }
  });

  test("every scoped gate in http-server.ts names its own route key, and each key has a row", async () => {
    // The two tests above tie the table to the exported constants and HTTP_ROUTE_AUTH, neither of
    // which sees what the server actually gates. A new regex-routed read gated with an EXISTING
    // key needs no new constant, no new HTTP_ROUTE_AUTH entry and no new row, so it would pass
    // both. Reading the server's gate call sites catches it: its key then appears twice.
    //
    // Scanned as Bun transpiles it, so comments are gone (a `see requireScopedSurface()` note is
    // not a call) and every call keeps one printed shape whatever the formatter did. A definition
    // still reads `function name(`, which the lookbehinds below exclude.
    const source = await Bun.file(join(import.meta.dir, "http-server.ts")).text();
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    const callsOf = (names: string): string[] =>
      code.match(new RegExp(String.raw`(?<!function )\b(?:${names})\(`, "g")) ?? [];

    // The scope check itself sits two levels down: requireScopedSurface calls
    // requireScopedClipToken, which calls enforceClipScope. A handler calling either of those
    // directly would gate a read with any key, outside everything below, so each must have its
    // one caller and no other.
    expect(code.match(/\bfunction (?:requireScopedSurface|requireEgressRead)\(/g)).toHaveLength(2);
    expect(callsOf("requireScopedClipToken")).toHaveLength(1);
    expect(callsOf("enforceClipScope")).toHaveLength(1);

    const gateCall =
      /(?<!function )\b(?:requireScopedSurface|requireEgressRead)\(\s*req,\s*opts,\s*(\w+)/g;
    const argNames = [...code.matchAll(gateCall)].map((m) => m[1] ?? "");
    // Every call is visible to the pattern above: anything else (other argument names, a call
    // spread over an alias) would sit outside this check, so the raw call count must agree.
    expect(argNames).toHaveLength(callsOf("requireScopedSurface|requireEgressRead").length);
    // requireEgressRead forwards its own `routeKey` parameter; every other site names a constant.
    expect(argNames.filter((name) => name === "routeKey")).toHaveLength(1);
    const keyNames = argNames.filter((name) => name !== "routeKey");
    expect(keyNames.length).toBeGreaterThan(0);
    expect(keyNames.filter((name) => !name.startsWith("ROUTE_KEY_"))).toEqual([]);

    expect(keyNames).toHaveLength(new Set(keyNames).size);
    const exported: Record<string, unknown> = routeAuth;
    const gatedKeys = keyNames.map((name) => String(exported[name])).sort();
    expect(gatedKeys).toEqual(SCOPED_ROUTES.map((route) => route.routeKey).sort());
  });
});

describe("scoped reads — the surface gate", () => {
  test("an unmounted surface answers its own 404 to every caller, token or not", async () => {
    const base = serve();
    for (const route of SCOPED_ROUTES) {
      for (const token of [undefined, BOGUS_TOKEN, FULL_TOKEN]) {
        await expectDisabled(await call(base, route, token), route);
      }
    }
  });

  test("a vault without the run store is still unmounted for briefs/agents, before any token read", async () => {
    // The run store is the SECOND half of these surfaces' mount. It refuses on that half first, with
    // the same named 404, so a gateway that pairs clients but runs no briefs/agents never tells a
    // caller anything about its tokens — the vault is not even read.
    const { vault, reads } = readCountingVault();
    const base = serve({ clipsVault: vault });
    for (const route of RUN_ROUTES) {
      for (const token of [undefined, BOGUS_TOKEN, FULL_TOKEN]) {
        await expectDisabled(await call(base, route, token), route);
      }
    }
    expect(reads()).toBe(0);

    // The control: the vault IS mounted on this server, so a vault-only route reaches the token
    // check and reads it. Without this, the zero above could mean the counter never counts.
    const resolve = SCOPED_ROUTES.find((r) => r.path.startsWith("/v1/items/resolve?"));
    if (resolve === undefined) throw new Error("table lost its resolve row");
    const res = await call(base, resolve, BOGUS_TOKEN);
    expect(res.status).toBe(401);
    expect(reads()).toBeGreaterThan(0);
  });

  test("a mounted surface: no token or an unknown one is 401, an out-of-scope one is 403", async () => {
    const base = serve({
      clipsVault: seededVault(),
      briefRuns: new BriefRunController({ nowMs: () => Date.now() }),
      agentRuns: new AgentRunController({ nowMs: () => Date.now() }),
    });
    for (const route of SCOPED_ROUTES) {
      for (const token of [undefined, BOGUS_TOKEN]) {
        const res = await call(base, route, token);
        expect({ path: route.path, status: res.status, body: await res.json() }).toEqual({
          path: route.path,
          status: 401,
          body: { error: "unauthorized" },
        });
      }
      const narrow = await call(base, route, NARROW_TOKEN);
      expect({ path: route.path, status: narrow.status, body: await narrow.json() }).toEqual({
        path: route.path,
        status: 403,
        body: { error: "insufficient_scope", required: route.scope, granted: ["fetch"] },
      });
    }
  });

  test("an in-scope token passes the gate on every route", async () => {
    // The positive half of the test above: a gate that refused unconditionally would pass it.
    const base = serve({
      clipsVault: seededVault(),
      briefRuns: new BriefRunController({ nowMs: () => Date.now() }),
      agentRuns: new AgentRunController({ nowMs: () => Date.now() }),
    });
    for (const route of SCOPED_ROUTES) {
      const res = await call(base, route, FULL_TOKEN);
      expect({ path: route.path, status: res.status }).toEqual({
        path: route.path,
        status: route.admitted.status,
      });
      if ("runMiss" in route.admitted) {
        // The run poll's own 404, not the gate's.
        expect(await res.json()).toEqual({ error: "not_found" });
      } else {
        await res.arrayBuffer();
      }
    }
  });
});

describe("run polls", () => {
  test("a held run is 200 with only its non-null fields; dropped is 410; unknown is 404", async () => {
    let now = 1_000_000;
    const nowMs = (): number => now;
    const briefIds = ["run_live", "run_failed"];
    const briefRuns = new BriefRunController({
      nowMs,
      ttlMs: 1_000,
      genId: () => briefIds.shift() ?? "run_extra",
    });
    const agentRuns = new AgentRunController({ nowMs, ttlMs: 1_000 });
    const base = serve({ clipsVault: seededVault(), briefRuns, agentRuns });
    const sources = [{ url: "https://example.com/a", title: "A" }];
    briefRuns.create({ brief: "live", sources, useIndex: false });
    const failed = briefRuns.create({ brief: "failed", sources, useIndex: false });
    if (!("run" in failed)) throw new Error("brief run store refused a run");
    briefRuns.fail(failed.run, "brief boom");
    expect(agentRuns.admit()).toEqual({ ok: true });
    agentRuns.open("expert_1_live");
    agentRuns.observe("agents.expert.briefError", { sessionId: "expert_2_failed", error: "boom" });
    agentRuns.observe("agents.expert.briefReady", {
      sessionId: "expert_3_done",
      brief: "# Expert",
      findings: { people: 1 },
    });

    const poll = async (path: string): Promise<{ status: number; body: unknown }> => {
      const res = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${FULL_TOKEN}` },
      });
      return { status: res.status, body: await res.json() };
    };

    const held: readonly [string, Record<string, unknown>][] = [
      ["/v1/briefs/run_live", { status: "collecting" }],
      ["/v1/briefs/run_failed", { status: "failed", failureReason: "brief boom" }],
      ["/v1/agents/runs/expert_1_live", { status: "running" }],
      ["/v1/agents/runs/expert_2_failed", { status: "failed", failureReason: "boom" }],
      [
        "/v1/agents/runs/expert_3_done",
        { status: "done", brief: "# Expert", findings: { people: 1 } },
      ],
    ];
    for (const [path, body] of held) {
      expect({ path, ...(await poll(path)) }).toEqual({ path, status: 200, body });
    }
    for (const path of ["/v1/briefs/run_never", "/v1/agents/runs/expert_9_never"]) {
      expect(await poll(path)).toEqual({ status: 404, body: { error: "not_found" } });
    }

    now += 1_001;
    for (const [path] of held) {
      expect({ path, ...(await poll(path)) }).toEqual({
        path,
        status: 410,
        body: { error: "expired" },
      });
    }
  });
});

describe("admin surface", () => {
  test("a refused admin bearer is plain text on /metrics and /admin, JSON on /v1/admin/status", async () => {
    const base = serve({
      statusReaders: STATUS_READERS,
      resolveAdminToken: () => Promise.resolve(ADMIN_TOKEN),
    });
    for (const path of ["/metrics", "/admin"]) {
      for (const headers of [{}, { authorization: `Bearer ${BOGUS_TOKEN}` }]) {
        const res = await fetch(`${base}${path}`, { headers });
        expect({
          path,
          status: res.status,
          type: res.headers.get("content-type"),
          body: await res.text(),
        }).toEqual({
          path,
          status: 401,
          type: "text/plain; charset=utf-8",
          body: "unauthorized\n",
        });
      }
    }
    const status = await fetch(`${base}/v1/admin/status`);
    expect(status.status).toBe(401);
    expect(status.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await status.json()).toEqual({ error: "unauthorized" });
  });

  test("the status surface needs BOTH halves; the console needs only the token resolver", async () => {
    const tokenOnly = serve({ resolveAdminToken: () => Promise.resolve(ADMIN_TOKEN) });
    const readersOnly = serve({ statusReaders: STATUS_READERS });
    const cases: readonly [string, string, number][] = [
      [tokenOnly, "/metrics", 404],
      [tokenOnly, "/v1/admin/status", 404],
      [tokenOnly, "/admin", 401],
      [readersOnly, "/metrics", 404],
      [readersOnly, "/v1/admin/status", 404],
      [readersOnly, "/admin", 404],
    ];
    for (const [base, path, status] of cases) {
      const res = await fetch(`${base}${path}`);
      const body = await res.text();
      expect({ path, status: res.status }).toEqual({ path, status });
      // An unmounted admin route falls through to the bare 404 an unmatched path answers.
      if (status === 404) expect(body).toBe("Not Found");
    }
  });

  test("an unmatched path is the bare 404", async () => {
    const base = serve();
    const res = await fetch(`${base}/v1/no-such-route`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  test("the console serves a built asset, the bare 404 for an absent one, and text when unbuilt", async () => {
    // Read per request (`defaultConsoleAssetDeps`), so setting it after boot still takes effect.
    const dist = mkdtempSync(join(tmpdir(), "nimbus-http-read-gates-console-"));
    dirs.push(dist);
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>read gates</title>");
    const prev = process.env["NIMBUS_ADMIN_CONSOLE_DIST"];
    try {
      const base = serve({ resolveAdminToken: () => Promise.resolve(ADMIN_TOKEN) });
      const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };

      process.env["NIMBUS_ADMIN_CONSOLE_DIST"] = dist;
      const index = await fetch(`${base}/admin`, { headers });
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await index.text()).toContain("<title>read gates</title>");
      const absent = await fetch(`${base}/admin/absent.js`, { headers });
      expect({ status: absent.status, body: await absent.text() }).toEqual({
        status: 404,
        body: "Not Found",
      });

      process.env["NIMBUS_ADMIN_CONSOLE_DIST"] = join(dist, "no-console-here");
      const unbuilt = await fetch(`${base}/admin`, { headers });
      expect(unbuilt.status).toBe(503);
      expect(unbuilt.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await unbuilt.text()).toStartWith("admin console not built");
    } finally {
      if (prev === undefined) delete process.env["NIMBUS_ADMIN_CONSOLE_DIST"];
      else process.env["NIMBUS_ADMIN_CONSOLE_DIST"] = prev;
    }
  });

  test("the console refuses a traversal path with a plain-text 400, and only after the bearer check", async () => {
    // `..%2f` is not a dot segment to the WHATWG URL parser, so the path reaches `safeAssetPath`
    // as sent. Had anything normalised it to `/secret`, the answer would be the bare 404 of an
    // unmatched path rather than the 400 below. Decided before any asset lookup: no console needed.
    const base = serve({ resolveAdminToken: () => Promise.resolve(ADMIN_TOKEN) });
    const path = "/admin/..%2fsecret";
    // Without a bearer the path is never examined: the caller learns nothing about what it names.
    const anonymous = await fetch(`${base}${path}`);
    expect({ status: anonymous.status, body: await anonymous.text() }).toEqual({
      status: 401,
      body: "unauthorized\n",
    });
    const res = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect({
      status: res.status,
      type: res.headers.get("content-type"),
      body: await res.text(),
    }).toEqual({ status: 400, type: "text/plain; charset=utf-8", body: "bad request\n" });
  });
});

describe("required query params", () => {
  test("an absent or EMPTY required param is refused, naming exactly that param", async () => {
    const base = serve();
    const cases: readonly [string, string][] = [
      ["/v1/metrics/dora", "service"],
      ["/v1/metrics/dora?service=", "service"],
      ["/v1/preflight/deploy?target_ref=main", "service"],
      ["/v1/preflight/deploy?service=&target_ref=main", "service"],
      ["/v1/preflight/deploy?service=svc", "target_ref"],
      ["/v1/preflight/deploy?service=svc&target_ref=", "target_ref"],
      ["/v1/metrics/stats?service=&metric=mttr&window_ms=1&bucket_ms=1", "service"],
      ["/v1/metrics/stats?service=svc&metric=&window_ms=1&bucket_ms=1", "metric"],
      ["/v1/metrics/stats?service=svc&metric=mttr&bucket_ms=1", "window_ms"],
      ["/v1/metrics/stats?service=svc&metric=mttr&window_ms=1", "bucket_ms"],
    ];
    for (const [path, missing] of cases) {
      const res = await fetch(`${base}${path}`);
      expect({ path, status: res.status, body: await res.json() }).toEqual({
        path,
        status: 400,
        body: { error: `missing required query param: ${missing}` },
      });
    }
  });

  test("whitespace is a VALUE, not absence: it reaches the dispatcher's own refusal", async () => {
    const base = serve();
    for (const path of [
      "/v1/metrics/dora?service=%20",
      "/v1/preflight/deploy?service=%20&target_ref=main",
    ]) {
      const res = await fetch(`${base}${path}`);
      expect({ path, status: res.status, body: await res.json() }).toEqual({
        path,
        status: 400,
        body: { error: "service must be 1..64 chars" },
      });
    }
  });

  test("an EMPTY window_ms / bucket_ms is not absence: it reaches the bucket check as 0", async () => {
    const base = serve({}, `[metrics.dora.svc]\nrepos = ["github:acme/web"]\n`);
    const cases: readonly [string, string][] = [
      ["window_ms=&bucket_ms=1", "window"],
      ["window_ms=1&bucket_ms=", "bucket"],
    ];
    for (const [query, label] of cases) {
      const res = await fetch(`${base}/v1/metrics/stats?service=svc&metric=mttr&${query}`);
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).not.toStartWith("missing required query param");
      expect(error).toBe(`${label} must be a positive integer number of ms, got 0`);
    }
  });
});

describe("RPC-backed public reads", () => {
  test("a dispatcher refusal is a 400 carrying its message verbatim, and nothing else", async () => {
    const base = serve();
    const cases: readonly [string, string][] = [
      [
        "/v1/metrics/dora?service=svc&since=bogus",
        String.raw`since must match \d+(d|h), got 'bogus'`,
      ],
      [
        "/v1/preflight/deploy?service=svc&target_ref=main&max_findings=999",
        "max_findings must be an integer 1..50",
      ],
    ];
    for (const [path, message] of cases) {
      const res = await fetch(`${base}${path}`);
      expect({ path, status: res.status, body: await res.json() }).toEqual({
        path,
        status: 400,
        body: { error: message },
      });
    }
  });

  test("the server's injected clock reaches all three dispatchers, never the wall clock", async () => {
    // One shared context builder threads `opts.nowMs` into metrics.dora, metrics.stats AND
    // deploy.preflight. The dora/stats/preflight route suites inject a clock as well, but none of
    // them asserts anything that depends on it — dropping it from that builder re-clocked all three
    // public routes with those suites still green. An instant years from the wall clock shows it.
    const FIXED_MS = Date.UTC(2020, 0, 2, 3, 4, 5, 678);
    const iso = new Date(FIXED_MS).toISOString();
    const base = serve(
      { nowMs: () => FIXED_MS },
      `[metrics.dora.svc]\nrepos = ["github:acme/web"]\n`,
    );
    /** Only the clock-derived fields: `computed_at` (dora, preflight) and `window` (stats). */
    type Clocked = { readonly computed_at?: unknown; readonly window?: unknown };
    const read = async (path: string): Promise<Clocked> => {
      const res = await fetch(`${base}${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      return (await res.json()) as Clocked;
    };

    expect((await read("/v1/metrics/dora?service=svc")).computed_at).toBe(iso);
    expect((await read("/v1/preflight/deploy?service=svc&target_ref=main")).computed_at).toBe(iso);
    const stats = await read(
      "/v1/metrics/stats?service=svc&metric=mttr&window_ms=86400000&bucket_ms=3600000",
    );
    expect(stats.window).toEqual({ since_ms: FIXED_MS - 86_400_000, until_ms: FIXED_MS });
  });

  test("any OTHER dispatcher throw is the generic 500, never the config parser's message", async () => {
    const base = serve({}, MALFORMED_TOML);
    for (const path of [
      "/v1/metrics/dora?service=secret-svc",
      "/v1/preflight/deploy?service=secret-svc&target_ref=main",
    ]) {
      const res = await fetch(`${base}${path}`);
      const raw = await res.text();
      expect({ path, status: res.status, body: JSON.parse(raw) as unknown }).toEqual({
        path,
        status: 500,
        body: { error: "internal_error" },
      });
      expect(raw).not.toContain("secret-svc");
    }
  });

  test("dora and preflight load the config lazily, stats eagerly: who answers a bad request differs", async () => {
    // dora and preflight hand the loader to their dispatcher as a THUNK, which validates params
    // before calling it — so on a malformed nimbus.toml a bad request is still told what is wrong
    // with IT. stats loads BEFORE dispatching, so past its bare-presence checks it answers
    // `config_unreadable` however invalid the params are. The two orders differ on purpose (see
    // `loadServiceConfigs`); this pins both.
    const base = serve({}, MALFORMED_TOML);
    const cases: readonly [string, number, Record<string, string>][] = [
      // The control: valid params on the same server reach the loader, so the config IS malformed
      // and the 400s below are the params' own refusals rather than an absent failure.
      ["/v1/metrics/dora?service=secret-svc", 500, { error: "internal_error" }],
      [
        "/v1/metrics/dora?service=secret-svc&since=bogus",
        400,
        { error: String.raw`since must match \d+(d|h), got 'bogus'` },
      ],
      [
        "/v1/preflight/deploy?service=secret-svc&target_ref=main&max_findings=999",
        400,
        { error: "max_findings must be an integer 1..50" },
      ],
      [
        "/v1/metrics/stats?service=secret-svc&metric=bogus&window_ms=1&bucket_ms=1",
        500,
        { error: "config_unreadable" },
      ],
    ];
    for (const [path, status, body] of cases) {
      const res = await fetch(`${base}${path}`);
      expect({ path, status: res.status, body: await res.json() }).toEqual({ path, status, body });
    }
  });
});

describe("the deployment write's service allow-list", () => {
  test("with no config dir wired, no service is known", async () => {
    const base = serve({ resolveDeploymentToken: () => Promise.resolve("deploy-token") });
    const res = await fetch(`${base}/v1/deployments`, {
      method: "POST",
      headers: { authorization: "Bearer deploy-token", "content-type": "application/json" },
      body: JSON.stringify({ service: "ghost-service" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "unknown_service",
      service: "ghost-service",
      known_services: [],
    });
  });

  test("with a config dir wired, its configured services are the known list", async () => {
    // The positive half: a resolver that ignored the config dir would pass the test above.
    const base = serve(
      { resolveDeploymentToken: () => Promise.resolve("deploy-token") },
      `[metrics.dora.svc]\nrepos = ["github:acme/web"]\n\n[metrics.dora.other]\nrepos = ["github:acme/api"]\n`,
    );
    const res = await fetch(`${base}/v1/deployments`, {
      method: "POST",
      headers: { authorization: "Bearer deploy-token", "content-type": "application/json" },
      body: JSON.stringify({ service: "ghost-service" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      readonly error: unknown;
      readonly service: unknown;
      readonly known_services: readonly string[];
    };
    // Sorted: the order is the TOML parser's, which is not what this pins.
    expect({ ...body, known_services: [...body.known_services].sort() }).toEqual({
      error: "unknown_service",
      service: "ghost-service",
      known_services: ["other", "svc"],
    });
  });
});
