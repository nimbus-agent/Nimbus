import type { Database } from "bun:sqlite";
import { getAllConnectorHealth } from "../../connectors/health.ts";
import { buildItemListSql, parseRelativeSinceToWindowMs } from "../../index/item-list-query.ts";
import { EMBEDDED_OPENAPI_YAML } from "../embedded-assets.ts";
import {
  ROUTE_KEY_AUDIT_LIST,
  ROUTE_KEY_ITEM_GET,
  ROUTE_KEY_ITEMS_LIST,
  ROUTE_KEY_PEOPLE_LIST,
  ROUTE_KEY_PERSON_GET,
} from "../http-route-auth.ts";
import { loadOpenApiJsonBytes } from "../openapi-loader.ts";
import { json, parsePositiveInt, requireScopedSurface } from "./_shared.ts";
import type { ReadOnlyHttpServerOptions } from "./options.ts";

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

export function handleConnectors(db: Database): Response {
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

export function handleOpenApiJson(): Response {
  const bytes = loadOpenApiJsonBytes(EMBEDDED_OPENAPI_YAML);
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const dataDisabled = (): Response => json({ error: "data_disabled" }, 404);

// One gate call per route in the two helpers below, each naming its own ROUTE_KEY_* constant
// (http-read-gates.test.ts derives the scoped-route table from exactly these call sites).

/** `/v1/items` and `/v1/items/<id>`; `null` means "not one of these routes". */
export async function tryItemsDataGet(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/v1/items") {
    const gate = await requireScopedSurface(req, opts, ROUTE_KEY_ITEMS_LIST, dataDisabled);
    return gate.ok ? handleItemsList(url, db) : gate.response;
  }
  if (path.startsWith("/v1/items/")) {
    const gate = await requireScopedSurface(req, opts, ROUTE_KEY_ITEM_GET, dataDisabled);
    return gate.ok ? handleItemByPath(path, db) : gate.response;
  }
  return null;
}

/** `/v1/people`, `/v1/people/<id>` and `/v1/audit`; `null` means "not one of these routes". */
export async function tryPeopleAuditDataGet(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/v1/people") {
    const gate = await requireScopedSurface(req, opts, ROUTE_KEY_PEOPLE_LIST, dataDisabled);
    return gate.ok ? handlePeopleList(db) : gate.response;
  }
  if (path.startsWith("/v1/people/")) {
    const gate = await requireScopedSurface(req, opts, ROUTE_KEY_PERSON_GET, dataDisabled);
    return gate.ok ? handlePersonByPath(path, db) : gate.response;
  }
  if (path === "/v1/audit") {
    const gate = await requireScopedSurface(req, opts, ROUTE_KEY_AUDIT_LIST, dataDisabled);
    return gate.ok ? handleAudit(url, db) : gate.response;
  }
  return null;
}
