// scim-http-routes.ts
//
// The SCIM provisioning surface is split in two so the write path is intrinsic to the I13
// pipeline (invariant): every POST/PATCH/DELETE flows through `dispatchWriteRoute` (bearer auth,
// rate-limit, body cap, audit-on-rejection) and lands here as `runScimWrite`, which owns only the
// SCIM *semantics* (provision / deprovision / leak-proof shape) and throws `ScimError` for the
// dispatcher to map + audit. The read path (`dispatchScimRead`, spec §6 roster list/read) is a
// bearer-checked GET — reads never write, so they stay off the I13 write surface.
import type { Database } from "bun:sqlite";
import type { NamespaceStore } from "../federation/namespace-store.ts";
import { requireBearer } from "../ipc/http-auth.ts";
import { deprovisionUser } from "./deprovision.ts";
import type { IdentityStore } from "./identity-store.ts";
import { applyScimCreate, parseScimPatchActive, ScimError } from "./scim-service.ts";
import type { ScimUser } from "./types.ts";

/** I13 — the SCIM write routes (these live in `WRITE_ROUTE_ALLOWLIST`; this mirror documents them). */
export const SCIM_WRITE_ROUTES: readonly string[] = Object.freeze([
  "POST /scim/v2/Users",
  "PATCH /scim/v2/Users/{id}",
  "DELETE /scim/v2/Users/{id}",
]);

const ITEM_RE = /^\/scim\/v2\/Users\/([^/]+)$/;

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

export function isScimPath(url: URL): boolean {
  return url.pathname === "/scim/v2/Users" || ITEM_RE.test(url.pathname);
}

function scimJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/scim+json" },
  });
}

/** The leak-proof SCIM User resource shape (id + userName + active only — never raw claims). */
function scimUserResource(u: ScimUser): Record<string, unknown> {
  return { schemas: [SCIM_USER_SCHEMA], id: u.externalId, userName: u.userName, active: u.active };
}

/** Coerces an already-parsed body to a SCIM resource object; throws ScimError(400) otherwise. */
function asScimResource(parsed: unknown): Record<string, unknown> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ScimError("invalid body", 400);
  }
  return parsed as Record<string, unknown>;
}

// ── Write path (runs inside dispatchWriteRoute) ───────────────────────────────────────────────

export interface ScimWriteContext {
  readonly writeDb: Database;
  readonly store: NamespaceStore;
  readonly identity: IdentityStore;
  readonly nowMs: () => number;
}

function applyScimPatch(id: string, parsed: unknown, ctx: ScimWriteContext): Response {
  const active = parseScimPatchActive(asScimResource(parsed));
  if (active === false) {
    deprovisionUser(
      { db: ctx.writeDb, store: ctx.store, identity: ctx.identity, nowMs: ctx.nowMs() },
      id,
    );
  } else if (active === true) {
    ctx.identity.setScimActive(id, true, ctx.nowMs());
  }
  const u = ctx.identity.getScimUser(id);
  return scimJson({ schemas: [SCIM_USER_SCHEMA], id, active: u?.active ?? false }, 200);
}

/**
 * Executes a SCIM write (create / patch / delete). Throws `ScimError` on a bad body or missing id;
 * the caller (`dispatchWriteRoute`) owns auth, rate-limiting, and rejection auditing.
 */
export async function runScimWrite(
  key: string,
  id: string | undefined,
  parsed: unknown,
  ctx: ScimWriteContext,
): Promise<Response> {
  if (key === "POST /scim/v2/Users") {
    const u = applyScimCreate(ctx.identity, asScimResource(parsed), ctx.nowMs());
    return scimJson(scimUserResource(u), 201);
  }
  if (id === undefined) throw new ScimError("missing id", 400);
  if (key === "DELETE /scim/v2/Users/{id}") {
    deprovisionUser(
      { db: ctx.writeDb, store: ctx.store, identity: ctx.identity, nowMs: ctx.nowMs() },
      id,
    );
    return new Response(null, { status: 204 });
  }
  return applyScimPatch(id, parsed, ctx);
}

// ── Read path (spec §6) ───────────────────────────────────────────────────────────────────────

export interface ScimReadContext {
  readonly identity: IdentityStore;
  readonly scimToken: string;
}

/** SCIM read surface (spec §6): list the roster or read a single User. Leak-proof shape only. */
function handleScimGet(url: URL, identity: IdentityStore): Response {
  const m = ITEM_RE.exec(url.pathname);
  if (m !== null) {
    const u = identity.getScimUser(m[1] as string);
    if (u === undefined) return scimJson({ detail: "not found", status: 404 }, 404);
    return scimJson(scimUserResource(u), 200);
  }
  const users = identity.listScimUsers();
  return scimJson(
    {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: users.length,
      Resources: users.map(scimUserResource),
    },
    200,
  );
}

/** Bearer-checked SCIM roster read. Empty token = surface disabled (503); bad token = 401. */
export function dispatchScimRead(req: Request, ctx: ScimReadContext): Response {
  if (ctx.scimToken === "") return scimJson({ detail: "scim_disabled", status: 503 }, 503);
  if (!requireBearer(req, { expectedToken: ctx.scimToken }).ok) {
    return scimJson({ detail: "unauthorized", status: 401 }, 401);
  }
  return handleScimGet(new URL(req.url), ctx.identity);
}
