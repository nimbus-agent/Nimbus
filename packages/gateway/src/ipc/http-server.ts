import { Database } from "bun:sqlite";
import { applyWritablePragmas } from "../db/writable-pragmas.ts";
import { dbRun } from "../db/write.ts";
import { IdentityStore } from "../identity/identity-store.ts";
import { dispatchScimRead, isScimPath } from "../identity/scim-http-routes.ts";
import { registerListener } from "../locality/listener-registry.ts";
import { rejectNonLoopbackHost } from "../locality/loopback-host-guard.ts";
import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";
import { HttpWriteRateLimiter } from "./http-rate-limit.ts";
import { json, notFound } from "./http-server/_shared.ts";
import { handleAdminConsole, handleAdminStatus, handleMetrics } from "./http-server/admin-reads.ts";
import { handleClipRelated } from "./http-server/clip-related.ts";
import {
  handleConnectors,
  handleOpenApiJson,
  tryItemsDataGet,
  tryPeopleAuditDataGet,
} from "./http-server/data-reads.ts";
import {
  handleEgressHead,
  handleEgressList,
  handleEgressProve,
  handleEgressVerify,
  PROVE_RATE_LIMIT,
} from "./http-server/egress-reads.ts";
import {
  handleDeployPreflight,
  handleMetricsDora,
  handleMetricsStats,
} from "./http-server/metrics-reads.ts";
import type { ReadOnlyHttpServerOptions } from "./http-server/options.ts";
import {
  handleItemsResolve,
  handleItemsResolveFile,
  handleItemsResolveIds,
  handleServicesResolve,
} from "./http-server/resolve-reads.ts";
import {
  AGENT_RUN_GET_RE,
  BRIEF_GET_RE,
  handleAgentRunGet,
  handleAgentsList,
  handleBriefGet,
} from "./http-server/run-reads.ts";
import { resolveWriteRouteDeps } from "./http-server/write-seams.ts";
import { dispatchWriteRoute, WRITE_ROUTE_ALLOWLIST } from "./http-write-routes.ts";

export type { ReadOnlyHttpServerOptions } from "./http-server/options.ts";

export type ReadOnlyHttpServerHandle = {
  readonly port: number;
  readonly stop: () => void;
};

// Read-only public routes (no bearer gate, never fall through). Returns null when `path` matches no
// public route, so the caller can try the bearer-gated admin routes before 404. The raw-row reads
// (items, people, audit) are NOT here: they need a `data`-scoped token — see `tryDataScopedGet`.
function dispatchReadOnlyDataGet(
  path: string,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> | Response | null {
  if (path === "/v1/health") {
    return json({ status: "ok", gateway: "read_only_http" });
  }
  if (path === "/v1/connectors") {
    return handleConnectors(db);
  }
  if (path === "/v1/metrics/dora") {
    return handleMetricsDora(url, db, opts);
  }
  if (path === "/v1/metrics/stats") {
    return handleMetricsStats(url, db, opts);
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
  return notFound();
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
  ensureFullSqlite();
  const db = new Database(dbPath, { create: false, readwrite: true });
  applyWritablePragmas(db);
  return db;
}

/**
 * The bearer-authed GET routes, or `null` when this request is not one of them.
 *
 * These MUST be matched before the unauthenticated GET table in `handleGet`,
 * which is documented "no bearer gate" — falling through to it would serve
 * these reads with no token check at all. Returning `null` rather than a 404 is
 * what preserves that ordering: it means "not mine", not "not found".
 *
 * Split out of the `fetch` handler for cognitive complexity (Sonar S3776 scored
 * it at 17); the handler now reads as a flat sequence of route families.
 */
async function tryBearerAuthedGet(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
  proveRateLimiter: HttpWriteRateLimiter,
): Promise<Response | null> {
  if (req.method !== "GET") return null;
  if (url.pathname === "/v1/items/resolve") return await handleItemsResolve(req, url, db, opts);
  if (url.pathname === "/v1/items/resolve-file")
    return await handleItemsResolveFile(req, url, db, opts);
  if (url.pathname === "/v1/items/resolve-ids")
    return await handleItemsResolveIds(req, url, db, opts);
  if (url.pathname === "/v1/services/resolve") return await handleServicesResolve(req, url, opts);
  if (url.pathname === "/v1/egress") return await handleEgressList(req, url, db, opts);
  if (url.pathname === "/v1/egress/head") return await handleEgressHead(req, db, opts);
  if (url.pathname === "/v1/egress/verify") return await handleEgressVerify(req, db, opts);
  if (url.pathname === "/v1/egress/prove")
    return await handleEgressProve(req, url, db, opts, proveRateLimiter);
  const briefGet = BRIEF_GET_RE.exec(url.pathname);
  if (briefGet !== null) return await handleBriefGet(req, briefGet[1] as string, opts);
  if (url.pathname === "/v1/agents") return await handleAgentsList(req, opts);
  const agentRun = AGENT_RUN_GET_RE.exec(url.pathname);
  if (agentRun !== null) return await handleAgentRunGet(req, agentRun[1] as string, opts);
  return await tryDataScopedGet(req, url, db, opts);
}

/**
 * The index's raw-row reads, behind a `data`-scoped client token. Matched AFTER every other
 * bearer read above, because `/v1/items/resolve*` share the `/v1/items/` prefix and must keep
 * their own `resolve` scope. `null` means "not one of these routes".
 */
async function tryDataScopedGet(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response | null> {
  const path = url.pathname;
  // A GET to a write route's path keeps its 405 from `handleGet`, never a data-scope answer.
  if (WRITE_ROUTE_ALLOWLIST.some((r) => r.endsWith(` ${path}`))) return null;
  return (
    (await tryItemsDataGet(req, url, db, opts)) ?? (await tryPeopleAuditDataGet(req, url, db, opts))
  );
}

export function startReadOnlyHttpServer(
  dbPath: string,
  port: number,
  opts: ReadOnlyHttpServerOptions = {},
): ReadOnlyHttpServerHandle {
  // In the gateway process this is a memoised no-op — `assemble.ts` got here first. It is called
  // anyway because this function is also the entry point of the standalone brief/agent test
  // servers, which open their own databases in their own processes. No-op off darwin.
  ensureFullSqlite();
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
  // Separate instance, not a per-route override on the one above: prove must not spend clip
  // ingest's budget, and a busy clipper must not make proving fail. See PROVE_RATE_LIMIT.
  const proveRateLimiter = new HttpWriteRateLimiter(PROVE_RATE_LIMIT);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req: Request): Promise<Response> {
      // DNS-rebinding guard: before ANY routing, since the unauthenticated data GETs below would
      // otherwise answer a rebound page (see loopback-host-guard.ts).
      const badHost = rejectNonLoopbackHost(req);
      if (badHost !== null) return badHost;
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
      const authedGet = await tryBearerAuthedGet(req, url, db, opts, proveRateLimiter);
      if (authedGet !== null) return authedGet;
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
  const unregisterListener = registerListener(() => ({
    name: "http",
    address: `127.0.0.1:${String(actualPort)}`,
    loopback: true,
  }));
  return {
    port: actualPort,
    stop(): void {
      unregisterListener();
      // Called now, as before; a synchronous throw or a rejection of the returned promise is ignored.
      Promise.try(() => server.stop()).catch(() => {});
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
