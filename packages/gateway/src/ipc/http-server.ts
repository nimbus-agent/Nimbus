import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { loadNimbusServiceConfigsFromConfigDir } from "../config/nimbus-toml.ts";
import { getAllConnectorHealth } from "../connectors/health.ts";
import { dbRun } from "../db/write.ts";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { IdentityStore } from "../identity/identity-store.ts";
import { dispatchScimRead, isScimPath } from "../identity/scim-http-routes.ts";
import { buildItemListSql, parseRelativeSinceToWindowMs } from "../index/item-list-query.ts";
import { formatPrometheus } from "../status/prometheus-format.ts";
import { contentTypeFor, resolveConsoleDist, safeAssetPath } from "./admin-console-assets.ts";
import { buildStatus, type StatusReaders } from "./admin-status-rpc.ts";
import { requireBearer } from "./http-auth.ts";
import { HttpWriteRateLimiter } from "./http-rate-limit.ts";
import {
  dispatchWriteRoute,
  type PolicyAuthorResult,
  WRITE_ROUTE_ALLOWLIST,
} from "./http-write-routes.ts";
import { dispatchMetricsRpc, MetricsRpcError } from "./metrics-rpc.ts";
import { loadOpenApiJsonBytes } from "./openapi-loader.ts";
import { dispatchPreflightRpc, PreflightRpcError } from "./preflight-rpc.ts";

export type ReadOnlyHttpServerOptions = {
  readonly configDir?: string;
  readonly nowMs?: () => number;
  readonly resolveDeploymentToken?: () => Promise<string>;
  readonly resolveScimToken?: () => Promise<string>;
  // Observability snapshot (Task 15). When BOTH are present, GET /v1/admin/status (JSON) and
  // GET /metrics (Prometheus text) are served, gated by a constant-time bearer check against
  // resolveAdminToken(). Absent either → the routes 404 (surface not mounted).
  readonly statusReaders?: StatusReaders;
  readonly resolveAdminToken?: () => Promise<string>;
  // Anchor policy write surface (Task 18b). When BOTH are present, PUT /v1/admin/policy is mounted
  // on the I13 write dispatcher (bearer = resolveAdminToken). `authorPolicy` is a policy/-resident
  // closure that validates+signs (Vault-only anchor key)+persists+applies — the route never parses
  // TOML itself (D16). Absent either → the route 404s (surface not mounted).
  readonly authorPolicy?: (toml: string) => Promise<PolicyAuthorResult>;
};

export type ReadOnlyHttpServerHandle = {
  readonly port: number;
  readonly stop: () => void;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parsePositiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === "") {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(Number.parseInt(raw, 10))));
}

function parseItemsListTimeFilters(
  url: URL,
  nowMs: number,
): {
  sinceMs: number | undefined;
  untilMs: number | undefined;
} {
  let sinceMs: number | undefined;
  const sinceRel = url.searchParams.get("since");
  if (sinceRel !== null && sinceRel.trim() !== "") {
    const rel = parseRelativeSinceToWindowMs(sinceRel, nowMs);
    if (rel !== undefined) {
      sinceMs = rel;
    }
  }
  const sinceMsParam = url.searchParams.get("sinceMs");
  if (sinceMs === undefined && sinceMsParam !== null && sinceMsParam !== "") {
    const n = Number(sinceMsParam);
    if (Number.isFinite(n)) {
      sinceMs = Math.floor(n);
    }
  }
  let untilMs: number | undefined;
  const untilMsParam = url.searchParams.get("untilMs");
  if (untilMsParam !== null && untilMsParam !== "") {
    const n = Number(untilMsParam);
    if (Number.isFinite(n)) {
      untilMs = Math.floor(n);
    }
  }
  return { sinceMs, untilMs };
}

function handleItemsList(url: URL, db: Database): Response {
  const services = url.searchParams.getAll("service");
  const type = url.searchParams.get("type") ?? undefined;
  const types = type === undefined || type === "" ? [] : [type];
  const limit = parsePositiveInt(url.searchParams.get("limit"), 50, 1000);
  const { sinceMs, untilMs } = parseItemsListTimeFilters(url, Date.now());
  const { sql, vals } = buildItemListSql({
    services,
    types,
    limit,
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(untilMs === undefined ? {} : { untilMs }),
  });
  const rows = db.query(sql).all(...vals) as Record<string, unknown>[];
  return json({ data: rows, meta: { total: rows.length, limit, offset: 0 } });
}

function handleItemByPath(path: string, db: Database): Response {
  const id = decodeURIComponent(path.slice("/v1/items/".length));
  if (id === "") {
    return json({ error: "missing id" }, 400);
  }
  const row = db
    .query("SELECT * FROM item WHERE id = ? OR external_id = ? LIMIT 1")
    .get(id, id) as Record<string, unknown> | null;
  return json({ data: row });
}

function handleConnectors(db: Database): Response {
  const health = getAllConnectorHealth(db);
  return json({
    data: health,
    meta: { total: health.length, limit: health.length, offset: 0 },
  });
}

function handlePeopleList(db: Database): Response {
  const rows = db
    .query("SELECT * FROM person ORDER BY display_name COLLATE NOCASE LIMIT 500")
    .all() as Record<string, unknown>[];
  return json({ data: rows, meta: { total: rows.length, limit: rows.length, offset: 0 } });
}

function handlePersonByPath(path: string, db: Database): Response {
  const id = decodeURIComponent(path.slice("/v1/people/".length));
  if (id === "") {
    return json({ error: "missing id" }, 400);
  }
  const row = db.query("SELECT * FROM person WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | null;
  return json({ data: row });
}

function handleAudit(url: URL, db: Database): Response {
  const lim = parsePositiveInt(url.searchParams.get("limit"), 50, 200);
  const rows = db
    .query(
      "SELECT id, action_type, hitl_status, action_json, timestamp FROM audit_log ORDER BY id DESC LIMIT ?",
    )
    .all(lim) as Record<string, unknown>[];
  return json({ data: rows, meta: { total: rows.length, limit: lim, offset: 0 } });
}

const OPENAPI_YAML_PATH = resolve(import.meta.dir, "..", "..", "openapi", "v1.yaml");

function handleOpenApiJson(): Response {
  const bytes = loadOpenApiJsonBytes(OPENAPI_YAML_PATH);
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function handleMetricsDora(
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const service = url.searchParams.get("service");
  if (service === null || service === "") {
    return json({ error: "missing required query param: service" }, 400);
  }
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw === null || sinceRaw === "" ? "30d" : sinceRaw;
  let out: Awaited<ReturnType<typeof dispatchMetricsRpc>>;
  try {
    out = await dispatchMetricsRpc(
      "metrics.dora",
      { service, since },
      {
        db,
        loadConfig: () =>
          opts.configDir === undefined
            ? new Map()
            : loadNimbusServiceConfigsFromConfigDir(opts.configDir),
        ...(opts.nowMs === undefined ? {} : { nowMs: opts.nowMs }),
      },
    );
  } catch (e) {
    if (e instanceof MetricsRpcError) {
      return json({ error: e.message }, 400);
    }
    throw e;
  }
  if (out.kind === "miss") {
    throw new Error("metrics.dora dispatcher returned miss");
  }
  return json(out.value);
}

async function handleDeployPreflight(
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const service = url.searchParams.get("service");
  if (service === null || service === "") {
    return json({ error: "missing required query param: service" }, 400);
  }
  const targetRef = url.searchParams.get("target_ref");
  if (targetRef === null || targetRef === "") {
    return json({ error: "missing required query param: target_ref" }, 400);
  }
  const maxFindingsRaw = url.searchParams.get("max_findings");
  const maxFindings =
    maxFindingsRaw === null || maxFindingsRaw === ""
      ? undefined
      : Number.parseInt(maxFindingsRaw, 10);
  if (maxFindings !== undefined && !Number.isInteger(maxFindings)) {
    return json({ error: "max_findings must be an integer" }, 400);
  }
  let out: Awaited<ReturnType<typeof dispatchPreflightRpc>>;
  try {
    out = await dispatchPreflightRpc(
      "deploy.preflight",
      maxFindings === undefined
        ? { service, target_ref: targetRef }
        : { service, target_ref: targetRef, max_findings: maxFindings },
      {
        db,
        loadConfig: () =>
          opts.configDir === undefined
            ? new Map()
            : loadNimbusServiceConfigsFromConfigDir(opts.configDir),
        ...(opts.nowMs === undefined ? {} : { nowMs: opts.nowMs }),
      },
    );
  } catch (e) {
    if (e instanceof PreflightRpcError) {
      return json({ error: e.message }, 400);
    }
    throw e;
  }
  if (out.kind === "miss") {
    throw new Error("deploy.preflight dispatcher returned miss");
  }
  return json(out.value);
}

// Observability (Task 15). The admin snapshot + Prometheus metrics share one bearer-gated surface:
// both require statusReaders + a resolveAdminToken. The bearer check is the EXACT I13 mechanism
// (requireBearer → constantTimeStringEqual) — a missing/empty token fails closed (surfaceDisabled).
async function handleAdminStatus(
  req: Request,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response | null> {
  const readers = opts.statusReaders;
  if (readers === undefined || opts.resolveAdminToken === undefined) return null;
  const expectedToken = await opts.resolveAdminToken();
  if (!requireBearer(req, { expectedToken }).ok) {
    return json({ error: "unauthorized" }, 401);
  }
  return json({ data: buildStatus(readers) });
}

async function handleMetrics(
  req: Request,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response | null> {
  const readers = opts.statusReaders;
  if (readers === undefined || opts.resolveAdminToken === undefined) return null;
  const expectedToken = await opts.resolveAdminToken();
  if (!requireBearer(req, { expectedToken }).ok) {
    return new Response("unauthorized\n", {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(formatPrometheus(buildStatus(readers)), {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}

// Admin console static assets (Task 17). Bearer-gated by the SAME resolveAdminToken used by
// /v1/admin/status: absent surface (no resolveAdminToken) → null (404, surface not mounted);
// invalid bearer → 401; console not built → 503; traversal → 400. GET-only, path-traversal-safe.
async function handleAdminConsole(
  req: Request,
  url: URL,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response | null> {
  if (opts.resolveAdminToken === undefined) return null;
  const expectedToken = await opts.resolveAdminToken();
  if (!requireBearer(req, { expectedToken }).ok) {
    return new Response("unauthorized\n", {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const dist = resolveConsoleDist(import.meta.dir);
  if (dist === undefined) {
    return new Response(
      "admin console not built — run: bun --filter @nimbus-dev/admin-console build\n",
      {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  }
  const rel = safeAssetPath(url.pathname);
  if (rel === undefined) {
    return new Response("bad request\n", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const file = Bun.file(join(dist, rel));
  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(file, { headers: { "content-type": contentTypeFor(rel) } });
}

async function dispatchReadOnlyGet(
  req: Request,
  path: string,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  if (path === "/v1/health") {
    return json({ status: "ok", gateway: "read_only_http" });
  }
  if (path === "/v1/items") {
    return handleItemsList(url, db);
  }
  if (path.startsWith("/v1/items/")) {
    return handleItemByPath(path, db);
  }
  if (path === "/v1/connectors") {
    return handleConnectors(db);
  }
  if (path === "/v1/people") {
    return handlePeopleList(db);
  }
  if (path.startsWith("/v1/people/")) {
    return handlePersonByPath(path, db);
  }
  if (path === "/v1/audit") {
    return handleAudit(url, db);
  }
  if (path === "/v1/metrics/dora") {
    return handleMetricsDora(url, db, opts);
  }
  if (path === "/v1/preflight/deploy") {
    return handleDeployPreflight(url, db, opts);
  }
  if (path === "/v1/openapi.json") {
    return handleOpenApiJson();
  }
  if (path === "/v1/admin/status") {
    const res = await handleAdminStatus(req, opts);
    if (res !== null) return res;
  }
  if (path === "/metrics") {
    const res = await handleMetrics(req, opts);
    if (res !== null) return res;
  }
  if (path === "/admin" || path.startsWith("/admin/")) {
    const res = await handleAdminConsole(req, url, opts);
    if (res !== null) return res;
  }
  return new Response("Not Found", { status: 404 });
}

// Every HTTP write (deployment annotation + SCIM provisioning) flows through the single I13
// dispatcher. The deployment token and the SCIM seam are resolved independently — a gateway can
// enable either surface alone — and dispatchWriteRoute selects per route.
async function handleWrite(
  req: Request,
  writeDb: Database | null,
  rateLimiter: HttpWriteRateLimiter,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  if (writeDb === null) {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
  }
  try {
    const expectedToken =
      opts.resolveDeploymentToken === undefined ? "" : await opts.resolveDeploymentToken();
    const cfgDir = opts.configDir;
    const knownServices =
      cfgDir === undefined
        ? (): readonly string[] => []
        : (): readonly string[] => Array.from(loadNimbusServiceConfigsFromConfigDir(cfgDir).keys());
    const scim =
      opts.resolveScimToken === undefined
        ? undefined
        : {
            token: await opts.resolveScimToken(),
            store: new NamespaceStore(writeDb),
            identity: new IdentityStore(writeDb),
          };
    // Policy write surface: present only when an admin token resolver AND an authorPolicy closure
    // are both wired. The bearer is the SAME admin token used by /v1/admin/status + /metrics.
    const policy =
      opts.authorPolicy === undefined || opts.resolveAdminToken === undefined
        ? undefined
        : {
            token: await opts.resolveAdminToken(),
            authorPolicy: opts.authorPolicy,
          };
    return await dispatchWriteRoute(req, {
      writeDb,
      expectedToken,
      rateLimiter,
      nowMs: opts.nowMs ?? ((): number => Date.now()),
      knownServices,
      ...(scim === undefined ? {} : { scim }),
      ...(policy === undefined ? {} : { policy }),
    });
  } catch {
    return json({ error: "internal_error" }, 500);
  }
}

async function handleGet(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const path = url.pathname;
  if (WRITE_ROUTE_ALLOWLIST.some((r) => r.endsWith(` ${path}`))) {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  try {
    return await dispatchReadOnlyGet(req, path, url, db, opts);
  } catch {
    return json({ error: "internal_error" }, 500);
  }
}

export function startReadOnlyHttpServer(
  dbPath: string,
  port: number,
  opts: ReadOnlyHttpServerOptions = {},
): ReadOnlyHttpServerHandle {
  const db = new Database(dbPath, { readonly: true, create: false });
  dbRun(db, "PRAGMA query_only = ON");

  // Single writable DB (I13). Opened when ANY write surface is enabled — deployment writes, SCIM
  // provisioning, OR the anchor policy write — each must work independently of the others.
  const writeDb =
    opts.resolveDeploymentToken === undefined &&
    opts.resolveScimToken === undefined &&
    opts.authorPolicy === undefined
      ? null
      : new Database(dbPath, { create: false, readwrite: true });
  const rateLimiter = new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      // SCIM roster read (spec §6) — bearer-checked GET; reads stay off the I13 write surface.
      if (
        writeDb !== null &&
        opts.resolveScimToken !== undefined &&
        isScimPath(url) &&
        req.method === "GET"
      ) {
        const scimToken = await opts.resolveScimToken();
        return dispatchScimRead(req, { identity: new IdentityStore(writeDb), scimToken });
      }
      // All writes (deployment POST + SCIM POST/PATCH/DELETE + policy PUT) → the single I13 dispatcher.
      if (
        req.method === "POST" ||
        req.method === "PATCH" ||
        req.method === "DELETE" ||
        req.method === "PUT"
      ) {
        return handleWrite(req, writeDb, rateLimiter, opts);
      }
      if (req.method !== "GET") {
        const allow = writeDb === null ? "GET" : "GET, POST";
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: allow } });
      }
      return handleGet(req, url, db, opts);
    },
  });

  const actualPort = server.port;
  if (typeof actualPort !== "number") {
    throw new TypeError(
      `startReadOnlyHttpServer: Bun.serve did not bind a TCP port (server.port=${String(actualPort)})`,
    );
  }
  return {
    port: actualPort,
    stop(): void {
      try {
        server.stop();
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
      if (writeDb !== null) {
        try {
          writeDb.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
