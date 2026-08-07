import { Database } from "bun:sqlite";
import type { AgentHttpInvoker } from "../agent-runs/agent-http-invoke.ts";
import type { AgentRunController } from "../agent-runs/agent-run-store.ts";
import type { BriefRunController } from "../briefs/brief-run-store.ts";
import type { ApiScope } from "../clips/api-scopes.ts";
import { ingestClip, validateClipInput } from "../clips/clip-ingest.ts";
import { type RelatedHit, type RelatedInput, runClipRelated } from "../clips/clip-related.ts";
import { addApiToken, generateClipToken, verifyApiToken } from "../clips/clip-token-store.ts";
import type { PairingWindowController } from "../clips/pairing-window.ts";
import { loadNimbusServiceConfigsFromConfigDir } from "../config/nimbus-toml.ts";
import { getAllConnectorHealth } from "../connectors/health.ts";
import { applyWritablePragmas } from "../db/writable-pragmas.ts";
import { dbRun } from "../db/write.ts";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { IdentityStore } from "../identity/identity-store.ts";
import { dispatchScimRead, isScimPath } from "../identity/scim-http-routes.ts";
import { buildItemListSql, parseRelativeSinceToWindowMs } from "../index/item-list-query.ts";
import { resolveItemByUrl } from "../index/resolve-by-url.ts";
import { ftsMatchQuery } from "../search/hybrid-internal.ts";
import { formatPrometheus } from "../status/prometheus-format.ts";
import type { TargetedFetchOutcome } from "../sync/targeted-fetch.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { contentTypeFor, resolveConsoleAsset, safeAssetPath } from "./admin-console-assets.ts";
import { buildStatus, type StatusReaders } from "./admin-status-rpc.ts";
import { HTTP_AGENT_NAMES } from "./agents-rpc.ts";
import { EMBEDDED_OPENAPI_YAML } from "./embedded-assets.ts";
import { bearerToken, requireBearer } from "./http-auth.ts";
import { HttpWriteRateLimiter } from "./http-rate-limit.ts";
import {
  type ClipReadRouteKey,
  enforceClipScope,
  ROUTE_KEY_AGENT_RUN_GET,
  ROUTE_KEY_AGENTS_LIST,
  ROUTE_KEY_BRIEF_GET,
  ROUTE_KEY_CLIPS_RELATED,
  ROUTE_KEY_ITEMS_RESOLVE,
} from "./http-route-auth.ts";
import {
  dispatchWriteRoute,
  type PolicyAuthorResult,
  type TeamsEventsSurface,
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
  // ChatOps Teams inbound surface (Slice 5). When present, POST /v1/messaging/teams/events is
  // mounted on the I13 write dispatcher; auth is the Bot Framework JWT (validated in-route), not a
  // static bearer. The surface (validateBotJwt + onActivity) is built by the ChatOps service.
  readonly resolveTeamsEventsSurface?: () => Promise<TeamsEventsSurface | undefined>;
  // Web-clipper surface (Task 6). When BOTH clipsVault and pairingController are present:
  //   - POST /v1/clips/related (bearer-authed read route) is mounted directly in the fetch handler.
  //   - The clips write seam (POST /v1/clips + POST /v1/clips/pair/confirm) is enabled in the I13
  //     write dispatcher. pairingController is a SINGLETON created at assemble time (Task 7) and
  //     shared with the clip-rpc IPC handler — http-server never constructs one per-request.
  readonly clipsVault?: NimbusVault;
  readonly pairingController?: PairingWindowController;
  // When present, called after each successful clip ingest to schedule embedding generation.
  readonly scheduleEmbedding?: (id: string) => void;
  // Research briefs (Task 12). Absent => every /v1/briefs route 404s. Reuses clipsVault for
  // bearer auth (same labeled clipper token map) — briefRuns alone is not enough to mount the
  // surface.
  readonly briefRuns?: BriefRunController;
  readonly briefStartRun?: (runId: string) => void;
  readonly briefSave?: (runId: string) => { itemId: string };
  // Agents over HTTP. BOTH are required to mount the surface (reads and the write route alike);
  // absent either, every /v1/agents route 404s with a named cause. Reuses clipsVault for bearer
  // auth, exactly as briefs do — agents never mint or hold their own token.
  readonly agentRuns?: AgentRunController;
  readonly agentInvoke?: AgentHttpInvoker;
  // Targeted fetch-on-miss (Task 11). Absent => POST /v1/items/fetch 404s (surface not mounted).
  // Built at assemble time because it needs the scheduler's syncables, its SyncContext and its
  // rate-limiter bucket, plus a Vault-derived fetch-host boundary — the HTTP layer must not reach
  // into connectors or the Vault itself. Reuses clipsVault for bearer auth (clipIngest precedent),
  // under its own `fetch` scope, distinct from `resolve`'s read-only local-index lookup.
  readonly fetchItem?: (url: string) => Promise<TargetedFetchOutcome>;
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

/**
 * Shared gate for the two inline bearer reads: 401 when the token is unknown, 403 when it is
 * known but out of scope, 500 when the route's `HTTP_ROUTE_AUTH` entry is itself misconfigured
 * (see `enforceClipScope`'s fail-closed contract). Returns the verified principal on success.
 *
 * `routeKey` must be the STATIC route constant (`ROUTE_KEY_BRIEF_GET` / `ROUTE_KEY_CLIPS_RELATED`),
 * never the raw request path — `clipScopeFor` looks the requirement up by that literal key. The
 * parameter type is narrowed to exactly those two constants: this function is never called any
 * other way, and the narrowing is what makes `enforceClipScope` returning "misconfigured" for this
 * routeKey a genuine table bug rather than a legitimately-unscoped route.
 */
async function requireScopedClipToken(
  req: Request,
  clipsVault: NimbusVault,
  routeKey: ClipReadRouteKey,
): Promise<{ ok: true; scopes: readonly ApiScope[] } | { ok: false; response: Response }> {
  const presented = bearerToken(req);
  const verified = presented === undefined ? null : await verifyApiToken(clipsVault, presented);
  if (verified === null) {
    return { ok: false, response: json({ error: "unauthorized" }, 401) };
  }
  const verdict = enforceClipScope(routeKey, verified.scopes);
  if (!verdict.ok) {
    return { ok: false, response: json(verdict.body, verdict.status) };
  }
  return { ok: true, scopes: verified.scopes };
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
    .query(
      `SELECT id, service, type, external_id, title, body, body_preview, body_complete,
              url, canonical_url, modified_at, author_id, metadata, synced_at, pinned
       FROM item WHERE id = ? OR external_id = ? LIMIT 1`,
    )
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

function handleOpenApiJson(): Response {
  const bytes = loadOpenApiJsonBytes(EMBEDDED_OPENAPI_YAML);
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
  const rel = safeAssetPath(url.pathname);
  if (rel === undefined) {
    return new Response("bad request\n", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const asset = resolveConsoleAsset(rel);
  if (asset.kind === "not-built") {
    return new Response(
      "admin console not built — run: bun --filter @nimbus-dev/admin-console build\n",
      {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  }
  if (asset.kind === "not-found") {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(Bun.file(asset.path), { headers: { "content-type": contentTypeFor(rel) } });
}

// Read-only data routes (no bearer gate, never fall through). Returns null when `path` matches no
// data route, so the caller can try the bearer-gated admin routes before 404.
function dispatchReadOnlyDataGet(
  path: string,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> | Response | null {
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
  return null;
}

// Bearer-gated admin routes (Task 15/17). Each handler returns null when its surface is not mounted
// (so the route falls through to 404); a non-null response (200/401/503/400) is served verbatim.
async function dispatchAdminGet(
  req: Request,
  path: string,
  url: URL,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response | null> {
  if (path === "/v1/admin/status") {
    return handleAdminStatus(req, opts);
  }
  if (path === "/metrics") {
    return handleMetrics(req, opts);
  }
  if (path === "/admin" || path.startsWith("/admin/")) {
    return handleAdminConsole(req, url, opts);
  }
  return null;
}

async function dispatchReadOnlyGet(
  req: Request,
  path: string,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const dataRes = dispatchReadOnlyDataGet(path, url, db, opts);
  if (dataRes !== null) {
    return dataRes;
  }
  const adminRes = await dispatchAdminGet(req, path, url, opts);
  if (adminRes !== null) {
    return adminRes;
  }
  return new Response("Not Found", { status: 404 });
}

type WriteRouteDeps = Parameters<typeof dispatchWriteRoute>[1];
type ScimWriteDeps = NonNullable<WriteRouteDeps["scim"]>;
type PolicyWriteDeps = NonNullable<WriteRouteDeps["policy"]>;

// SCIM provisioning seam — present only when a SCIM bearer resolver is wired.
async function resolveScimWriteDeps(
  writeDb: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<ScimWriteDeps | undefined> {
  if (opts.resolveScimToken === undefined) {
    return undefined;
  }
  return {
    token: await opts.resolveScimToken(),
    store: new NamespaceStore(writeDb),
    identity: new IdentityStore(writeDb),
  };
}

// Policy write surface: present only when an admin token resolver AND an authorPolicy closure are
// both wired. The bearer is the SAME admin token used by /v1/admin/status + /metrics.
async function resolvePolicyWriteDeps(
  opts: ReadOnlyHttpServerOptions,
): Promise<PolicyWriteDeps | undefined> {
  if (opts.authorPolicy === undefined || opts.resolveAdminToken === undefined) {
    return undefined;
  }
  return {
    token: await opts.resolveAdminToken(),
    authorPolicy: opts.authorPolicy,
  };
}

// POST /v1/clips/related — bearer-authed read route (no DB mutation). Uses FTS-only search over
// the read-only DB so no embedding pipeline is required. The query is sanitized via ftsMatchQuery
// (the same escaping used by the hybrid-search BM25 path) to prevent FTS5 syntax injection.
async function handleClipRelated(
  req: Request,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const { clipsVault } = opts;
  if (clipsVault === undefined) {
    return new Response("Not Found", { status: 404 });
  }
  const auth = await requireScopedClipToken(req, clipsVault, ROUTE_KEY_CLIPS_RELATED);
  if (!auth.ok) return auth.response;
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json({ error: "invalid_request", detail: "body must be a JSON object" }, 400);
  }
  const body = parsed as RelatedInput;
  const out = await runClipRelated(
    {
      search: async (query: string, limit: number): Promise<RelatedHit[]> => {
        const fts = ftsMatchQuery(query);
        if (fts === "") return [];
        const rows = db
          .query(
            `SELECT i.id, i.title, i.service, i.url,
                    snippet(item_fts, 0, '', '', '…', 10) AS snippet
             FROM item i
             INNER JOIN item_fts ON i.rowid = item_fts.rowid
             WHERE item_fts MATCH ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(fts, limit) as Array<{
          id: string;
          title: string;
          service: string;
          url: string | null;
          snippet: string;
        }>;
        return rows.map((r) => ({
          id: r.id,
          title: r.title,
          service: r.service,
          snippet: r.snippet,
          url: r.url,
        }));
      },
    },
    body,
  );
  return json(out);
}

// GET /v1/items/resolve?url= — bearer-authed read under the `resolve` scope. Mounted in the fetch
// handler, NOT reachable via dispatchReadOnlyDataGet: that table's "/v1/items/*" entry is PUBLIC
// (handleItemByPath, no bearer gate at all), so routing resolve through it would serve scoped
// output — including which URLs are indexed — to any local process on the machine.
//
// Returns resolveItemByUrl's result unchanged (metadata only) and appends NO egress row.
async function handleItemsResolve(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const clipsVault = opts.clipsVault;
  if (clipsVault === undefined) {
    // Same "surface not mounted" shape as handleAgentsList/agentsDisabled(): a named 404, never a
    // fall-through to the public /v1/items/* table.
    return json({ error: "resolve_disabled" }, 404);
  }
  const auth = await requireScopedClipToken(req, clipsVault, ROUTE_KEY_ITEMS_RESOLVE);
  if (!auth.ok) return auth.response;
  const raw = url.searchParams.get("url");
  if (raw === null || raw.trim() === "") {
    return json({ error: "missing_url" }, 400);
  }
  return json(resolveItemByUrl(db, raw));
}

// GET /v1/briefs/{id} — bearer-authed read of an in-memory run. Mounted in the fetch handler,
// NOT in dispatchReadOnlyDataGet: that table is documented "no bearer gate", so routing briefs
// through it would expose a user's research report to any local process on the machine.
const BRIEF_GET_RE = /^\/v1\/briefs\/(\w{1,64})$/;

/** Kept identical to http-write-routes.ts BRIEF_DISABLED_HINT — one string, two surfaces. */
const BRIEFS_DISABLED_HINT = "research briefs disabled — enable [briefs] in nimbus.toml";

async function handleBriefGet(
  req: Request,
  id: string,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const clipsVault = opts.clipsVault;
  const runs = opts.briefRuns;
  if (clipsVault === undefined || runs === undefined) {
    // Same body as the POST routes' 404 so the client renders one string, not two.
    return json({ error: "briefs_disabled", hint: BRIEFS_DISABLED_HINT }, 404);
  }
  // Shared parser from http-auth.ts (Task 1) — same header handling as the write dispatcher.
  const auth = await requireScopedClipToken(req, clipsVault, ROUTE_KEY_BRIEF_GET);
  if (!auth.ok) return auth.response;
  const run = runs.get(id);
  if (run === null) {
    return runs.wasKnown(id) ? json({ error: "expired" }, 410) : json({ error: "not_found" }, 404);
  }
  // `failureReason`, NOT `error`: on every other route here `error` means an HTTP-level
  // failure, so reusing it for a legitimately-failed run would make `if (body.error)` —
  // the obvious client check — misread a normal outcome as a transport error.
  return json(
    {
      status: run.status,
      ...(run.report === null ? {} : { report: run.report }),
      ...(run.error === null ? {} : { failureReason: run.error }),
    },
    200,
  );
}

// GET /v1/agents/runs/{id} — bearer-authed read of an in-memory run. Mounted in the fetch handler,
// NOT in dispatchReadOnlyDataGet: that table is documented "no bearer gate", so routing a brief
// synthesised from the private index through it would expose it to any local process on the machine.
const AGENT_RUN_GET_RE = /^\/v1\/agents\/runs\/(\w{1,64})$/;

/** Kept identical to http-write-routes.ts AGENTS_DISABLED_HINT — one string, two surfaces. */
const AGENTS_DISABLED_HINT = "agent invocation over HTTP disabled — no local index is wired";

/** 404 that names the cause, so a client can write first-run copy instead of guessing. */
function agentsDisabled(): Response {
  return json({ error: "agents_disabled", hint: AGENTS_DISABLED_HINT }, 404);
}

async function handleAgentsList(req: Request, opts: ReadOnlyHttpServerOptions): Promise<Response> {
  const clipsVault = opts.clipsVault;
  if (clipsVault === undefined || opts.agentRuns === undefined) return agentsDisabled();
  const auth = await requireScopedClipToken(req, clipsVault, ROUTE_KEY_AGENTS_LIST);
  if (!auth.ok) return auth.response;
  // Derived from AGENTS_RPC_HANDLERS, so it cannot advertise a name that POST would then 404.
  return json({ agents: [...HTTP_AGENT_NAMES] }, 200);
}

async function handleAgentRunGet(
  req: Request,
  id: string,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const clipsVault = opts.clipsVault;
  const runs = opts.agentRuns;
  if (clipsVault === undefined || runs === undefined) return agentsDisabled();
  const auth = await requireScopedClipToken(req, clipsVault, ROUTE_KEY_AGENT_RUN_GET);
  if (!auth.ok) return auth.response;
  const run = runs.get(id);
  if (run === null) {
    // 404 means "unknown OR lost to a gateway restart" — the tombstone set is in-memory, so a
    // client polling across a restart cannot see 410. Both are terminal: re-issue the call, never
    // keep waiting. 410 means known-and-expired within this process lifetime.
    return runs.wasKnown(id) ? json({ error: "expired" }, 410) : json({ error: "not_found" }, 404);
  }
  // `failureReason`, NOT `error`: on every other route here `error` means an HTTP-level failure, so
  // reusing it for a legitimately-failed run would make `if (body.error)` — the obvious client
  // check — misread a normal outcome as a transport error. Same choice as handleBriefGet.
  return json(
    {
      status: run.status,
      ...(run.brief === null ? {} : { brief: run.brief }),
      ...(run.findings === null ? {} : { findings: run.findings }),
      ...(run.error === null ? {} : { failureReason: run.error }),
    },
    200,
  );
}

// Agent-invocation write seam — present only when clipsVault, agentRuns AND agentInvoke are all
// wired. verifyToken reuses the same labeled client token map as the web clipper and briefs.
function buildAgentsSeam(opts: ReadOnlyHttpServerOptions) {
  const clipsVault = opts.clipsVault;
  const runs = opts.agentRuns;
  const invoke = opts.agentInvoke;
  if (clipsVault === undefined || runs === undefined || invoke === undefined) return undefined;
  return { verifyToken: (t: string) => verifyApiToken(clipsVault, t), invoke };
}

// Web-clipper write seam — present only when BOTH clipsVault AND pairingController are wired.
// pairingController is a singleton from assemble.ts (Task 7); http-server never constructs one.
// Capture into locals so TS narrows them inside the closures (avoids non-null assertions).
function buildClipsSeam(writeDb: Database, opts: ReadOnlyHttpServerOptions) {
  const clipsVault = opts.clipsVault;
  const pairingController = opts.pairingController;
  const scheduleEmbedding = opts.scheduleEmbedding;
  if (clipsVault === undefined || pairingController === undefined) return undefined;
  return {
    pairing: pairingController,
    verifyToken: (t: string) => verifyApiToken(clipsVault, t),
    mintToken: async (label: string, scopes: readonly ApiScope[]): Promise<string> => {
      const token = generateClipToken();
      await addApiToken(clipsVault, label, token, scopes);
      return token;
    },
    ingest: (input: unknown) => ingestClip(writeDb, validateClipInput(input), scheduleEmbedding),
  };
}

// Targeted-fetch write seam — present only when BOTH clipsVault AND fetchItem are wired.
// verifyToken reuses the same labeled clipper token map as the web clipper / agents / briefs
// (clipIngest precedent) — this route never mints or holds its own token.
function buildFetchSeam(opts: ReadOnlyHttpServerOptions) {
  const clipsVault = opts.clipsVault;
  const fetchItem = opts.fetchItem;
  if (clipsVault === undefined || fetchItem === undefined) return undefined;
  return { verifyToken: (t: string) => verifyApiToken(clipsVault, t), fetchItem };
}

// Research-briefs write seam — present only when clipsVault, briefRuns, briefStartRun, AND
// briefSave are ALL wired. verifyToken reuses the same labeled clipper token map as the web
// clipper (clipIngest precedent) — briefs never mint or hold their own token.
function buildBriefsSeam(opts: ReadOnlyHttpServerOptions) {
  const clipsVault = opts.clipsVault;
  const controller = opts.briefRuns;
  const startRun = opts.briefStartRun;
  const save = opts.briefSave;
  if (
    clipsVault === undefined ||
    controller === undefined ||
    startRun === undefined ||
    save === undefined
  ) {
    return undefined;
  }
  return {
    controller,
    verifyToken: (t: string) => verifyApiToken(clipsVault, t),
    startRun,
    save,
  };
}

// The deployment-annotation bearer token, or "" when that seam is unwired.
async function resolveExpectedToken(opts: ReadOnlyHttpServerOptions): Promise<string> {
  return opts.resolveDeploymentToken === undefined ? "" : await opts.resolveDeploymentToken();
}

// Lazily lists the configured service ids (empty when no config dir is wired).
function resolveKnownServices(opts: ReadOnlyHttpServerOptions): () => readonly string[] {
  const cfgDir = opts.configDir;
  return cfgDir === undefined
    ? (): readonly string[] => []
    : (): readonly string[] => Array.from(loadNimbusServiceConfigsFromConfigDir(cfgDir).keys());
}

// The Teams events messaging surface, or undefined when that seam is unwired.
async function resolveMessagingSurface(opts: ReadOnlyHttpServerOptions) {
  return opts.resolveTeamsEventsSurface === undefined
    ? undefined
    : await opts.resolveTeamsEventsSurface();
}

// Assembles the full I13 dispatcher dependency set. Each write seam (deployment token, SCIM,
// policy, messaging) is resolved independently — a gateway can enable any surface alone.
async function resolveWriteRouteDeps(
  writeDb: Database,
  rateLimiter: HttpWriteRateLimiter,
  opts: ReadOnlyHttpServerOptions,
): Promise<WriteRouteDeps> {
  const scim = await resolveScimWriteDeps(writeDb, opts);
  const policy = await resolvePolicyWriteDeps(opts);
  const messaging = await resolveMessagingSurface(opts);
  const clips = buildClipsSeam(writeDb, opts);
  const briefs = buildBriefsSeam(opts);
  const agents = buildAgentsSeam(opts);
  const fetchSeam = buildFetchSeam(opts);
  return {
    writeDb,
    expectedToken: await resolveExpectedToken(opts),
    rateLimiter,
    nowMs: opts.nowMs ?? ((): number => Date.now()),
    knownServices: resolveKnownServices(opts),
    ...(scim === undefined ? {} : { scim }),
    ...(policy === undefined ? {} : { policy }),
    ...(messaging === undefined ? {} : { messaging }),
    ...(clips === undefined ? {} : { clips }),
    ...(briefs === undefined ? {} : { briefs }),
    ...(agents === undefined ? {} : { agents }),
    ...(fetchSeam === undefined ? {} : { fetch: fetchSeam }),
  };
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
    return await dispatchWriteRoute(req, await resolveWriteRouteDeps(writeDb, rateLimiter, opts));
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
  const matchedRoute = WRITE_ROUTE_ALLOWLIST.find((r) => r.endsWith(` ${path}`));
  if (matchedRoute !== undefined) {
    const allow = matchedRoute.split(" ")[0] ?? "POST";
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: allow } });
  }
  try {
    return await dispatchReadOnlyGet(req, path, url, db, opts);
  } catch {
    return json({ error: "internal_error" }, 500);
  }
}

/**
 * The I13 writable handle. Separate from the read-only handle above because it
 * needs the writable pragmas; `journal_mode` in particular cannot be set from a
 * read-only connection, so a read handle inherits whatever the file already is.
 */
function openI13WriteHandle(dbPath: string): Database {
  const db = new Database(dbPath, { create: false, readwrite: true });
  applyWritablePragmas(db);
  return db;
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
  // The policy write surface mounts only when BOTH authorPolicy AND resolveAdminToken
  // are wired (see the `policy` gate below). Opening the writable handle on authorPolicy
  // alone would over-elevate the server when the admin token is absent and the surface is
  // not actually mountable — so require both for the policy branch.
  const writeDb =
    opts.resolveDeploymentToken === undefined &&
    opts.resolveScimToken === undefined &&
    opts.resolveTeamsEventsSurface === undefined &&
    opts.clipsVault === undefined &&
    opts.briefRuns === undefined &&
    opts.agentRuns === undefined &&
    opts.fetchItem === undefined &&
    (opts.authorPolicy === undefined || opts.resolveAdminToken === undefined)
      ? null
      : openI13WriteHandle(dbPath);
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
      // POST /v1/clips/related — bearer-authed read route (no mutation); intercept before the
      // I13 write dispatcher so it never appears on the write surface allowlist.
      if (req.method === "POST" && url.pathname === "/v1/clips/related") {
        return handleClipRelated(req, db, opts);
      }
      // GET /v1/items/resolve, GET /v1/briefs/{id}, GET /v1/agents and GET /v1/agents/runs/{id} —
      // bearer-authed reads; intercept before the unauthenticated GET table, which is documented
      // "no bearer gate".
      if (req.method === "GET") {
        if (url.pathname === "/v1/items/resolve")
          return await handleItemsResolve(req, url, db, opts);
        const briefGet = BRIEF_GET_RE.exec(url.pathname);
        if (briefGet !== null) return await handleBriefGet(req, briefGet[1] as string, opts);
        if (url.pathname === "/v1/agents") return await handleAgentsList(req, opts);
        const agentRun = AGENT_RUN_GET_RE.exec(url.pathname);
        if (agentRun !== null) return await handleAgentRunGet(req, agentRun[1] as string, opts);
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
