// scim-http-routes.ts
import type { Database } from "bun:sqlite";
import type { NamespaceStore } from "../federation/namespace-store.ts";
import { requireBearer } from "../ipc/http-auth.ts";
import { deprovisionUser } from "./deprovision.ts";
import type { IdentityStore } from "./identity-store.ts";
import { applyScimCreate, parseScimPatchActive, ScimError } from "./scim-service.ts";

/** I13 — the SCIM write surface allowlist (mirrors WRITE_ROUTE_ALLOWLIST's discipline). */
export const SCIM_WRITE_ROUTES: readonly string[] = Object.freeze([
  "POST /scim/v2/Users",
  "PATCH /scim/v2/Users/{id}",
  "DELETE /scim/v2/Users/{id}",
]);

const ITEM_RE = /^\/scim\/v2\/Users\/([^/]+)$/;

export interface ScimRouteContext {
  readonly writeDb: Database;
  readonly store: NamespaceStore;
  readonly identity: IdentityStore;
  readonly scimToken: string;
  readonly nowMs: () => number;
}

export function isScimPath(url: URL): boolean {
  return url.pathname === "/scim/v2/Users" || ITEM_RE.test(url.pathname);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/scim+json" },
  });
}

function normalizedKey(method: string, url: URL): string | undefined {
  if (method === "POST" && url.pathname === "/scim/v2/Users") return "POST /scim/v2/Users";
  if (ITEM_RE.test(url.pathname) && (method === "PATCH" || method === "DELETE")) {
    return `${method} /scim/v2/Users/{id}`;
  }
  return undefined;
}

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

/** Parses + validates a JSON request body; throws ScimError(400) on a non-object body. */
async function readScimBody(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json();
  if (body === null || typeof body !== "object") throw new ScimError("invalid body", 400);
  return body as Record<string, unknown>;
}

function deprovision(ctx: ScimRouteContext, id: string): void {
  deprovisionUser(
    { db: ctx.writeDb, store: ctx.store, identity: ctx.identity, nowMs: ctx.nowMs() },
    id,
  );
}

async function handleScimCreate(req: Request, ctx: ScimRouteContext): Promise<Response> {
  const u = applyScimCreate(ctx.identity, await readScimBody(req), ctx.nowMs());
  return json(
    { schemas: [SCIM_USER_SCHEMA], id: u.externalId, userName: u.userName, active: u.active },
    201,
  );
}

async function handleScimPatch(req: Request, ctx: ScimRouteContext, id: string): Promise<Response> {
  const active = parseScimPatchActive(await readScimBody(req));
  if (active === false) deprovision(ctx, id);
  else if (active === true) ctx.identity.setScimActive(id, true, ctx.nowMs());
  const u = ctx.identity.getScimUser(id);
  return json({ schemas: [SCIM_USER_SCHEMA], id, active: u?.active ?? false }, 200);
}

async function routeScim(key: string, req: Request, ctx: ScimRouteContext): Promise<Response> {
  if (key === "POST /scim/v2/Users") return handleScimCreate(req, ctx);
  const id = ITEM_RE.exec(new URL(req.url).pathname)?.[1];
  if (id === undefined) throw new ScimError("missing id", 400);
  if (key === "DELETE /scim/v2/Users/{id}") {
    deprovision(ctx, id);
    return new Response(null, { status: 204 });
  }
  return handleScimPatch(req, ctx, id);
}

export async function dispatchScimRoute(req: Request, ctx: ScimRouteContext): Promise<Response> {
  const key = normalizedKey(req.method, new URL(req.url));
  if (key === undefined || !SCIM_WRITE_ROUTES.includes(key)) {
    return json({ detail: "not_found", status: 404 }, 404);
  }
  if (ctx.scimToken === "") return json({ detail: "scim_disabled", status: 503 }, 503);
  if (!requireBearer(req, { expectedToken: ctx.scimToken }).ok) {
    return json({ detail: "unauthorized", status: 401 }, 401);
  }
  try {
    return await routeScim(key, req, ctx);
  } catch (e) {
    if (e instanceof ScimError) return json({ detail: e.message, status: e.status }, e.status);
    return json({ detail: "internal_error", status: 500 }, 500);
  }
}
