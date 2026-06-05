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

export async function dispatchScimRoute(req: Request, ctx: ScimRouteContext): Promise<Response> {
  const url = new URL(req.url);
  const key = normalizedKey(req.method, url);
  if (key === undefined || !SCIM_WRITE_ROUTES.includes(key)) {
    return json({ detail: "not_found", status: 404 }, 404);
  }
  if (ctx.scimToken === "") return json({ detail: "scim_disabled", status: 503 }, 503);
  const auth = requireBearer(req, { expectedToken: ctx.scimToken });
  if (!auth.ok) return json({ detail: "unauthorized", status: 401 }, 401);

  try {
    if (key === "POST /scim/v2/Users") {
      const body: unknown = await req.json();
      if (body === null || typeof body !== "object") throw new ScimError("invalid body", 400);
      const u = applyScimCreate(ctx.identity, body as Record<string, unknown>, ctx.nowMs());
      return json(
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          id: u.externalId,
          userName: u.userName,
          active: u.active,
        },
        201,
      );
    }
    const id = ITEM_RE.exec(url.pathname)?.[1];
    if (id === undefined) throw new ScimError("missing id", 400);
    if (key === "DELETE /scim/v2/Users/{id}") {
      deprovisionUser(
        { db: ctx.writeDb, store: ctx.store, identity: ctx.identity, nowMs: ctx.nowMs() },
        id,
      );
      return new Response(null, { status: 204 });
    }
    // PATCH
    const body: unknown = await req.json();
    if (body === null || typeof body !== "object") throw new ScimError("invalid body", 400);
    const active = parseScimPatchActive(body as Record<string, unknown>);
    if (active === false) {
      deprovisionUser(
        { db: ctx.writeDb, store: ctx.store, identity: ctx.identity, nowMs: ctx.nowMs() },
        id,
      );
    } else if (active === true) {
      ctx.identity.setScimActive(id, true, ctx.nowMs());
    }
    const u = ctx.identity.getScimUser(id);
    return json(
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], id, active: u?.active ?? false },
      200,
    );
  } catch (e) {
    if (e instanceof ScimError) return json({ detail: e.message, status: e.status }, e.status);
    return json({ detail: "internal_error", status: 500 }, 500);
  }
}
