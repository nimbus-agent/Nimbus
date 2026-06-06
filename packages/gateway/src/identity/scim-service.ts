// scim-service.ts
import type { IdentityStore } from "./identity-store.ts";
import type { ScimUser } from "./types.ts";

export class ScimError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Non-PII allowlist (spec §6.1). Everything not named here is dropped before storage. */
export function projectScimAttrs(resource: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof resource["displayName"] === "string") out["displayName"] = resource["displayName"];
  const name = rec(resource["name"]);
  if (name !== undefined && typeof name["formatted"] === "string")
    out["name"] = { formatted: name["formatted"] };
  const meta = rec(resource["meta"]);
  if (meta !== undefined && typeof meta["lastModified"] === "string")
    out["meta"] = { lastModified: meta["lastModified"] };
  return out;
}

function primaryEmail(resource: Record<string, unknown>): string | null {
  const emails = resource["emails"];
  if (!Array.isArray(emails)) return null;
  const primary = emails.find((e) => rec(e)?.["primary"] === true) ?? emails[0];
  const v = rec(primary)?.["value"];
  return typeof v === "string" ? v : null;
}

export function toScimUser(resource: Record<string, unknown>): ScimUser {
  const externalId = resource["externalId"] ?? resource["id"];
  if (typeof externalId !== "string" || externalId.length === 0) {
    throw new ScimError("missing externalId", 400);
  }
  const active = resource["active"];
  return {
    externalId,
    userName: typeof resource["userName"] === "string" ? resource["userName"] : null,
    email: primaryEmail(resource),
    active: active === undefined ? true : active === true,
    attrs: projectScimAttrs(resource),
  };
}

export function applyScimCreate(
  store: IdentityStore,
  resource: Record<string, unknown>,
  nowMs: number,
): ScimUser {
  const u = toScimUser(resource);
  store.upsertScimUser(u, nowMs);
  return u;
}

/** SCIM `active` must be a JSON boolean; coercing anything else risks a silent deprovision. */
function asActiveBool(v: unknown): boolean {
  if (typeof v !== "boolean") throw new ScimError("invalid active value", 400);
  return v;
}

/** Returns the `active` value a single replace/add PatchOp sets, or undefined if it sets none. */
function patchOpActive(op: unknown): boolean | undefined {
  const o = rec(op);
  if (o === undefined) return undefined;
  const opName = typeof o["op"] === "string" ? o["op"].toLowerCase() : "";
  if (opName !== "replace" && opName !== "add") return undefined;
  if (o["path"] === "active") return asActiveBool(o["value"]);
  const val = rec(o["value"]);
  if (val !== undefined && "active" in val) return asActiveBool(val["active"]);
  return undefined;
}

/** Returns the new `active` value if a PatchOp sets it, else undefined (last op wins). */
export function parseScimPatchActive(patch: Record<string, unknown>): boolean | undefined {
  const ops = patch["Operations"];
  if (!Array.isArray(ops)) return undefined;
  let result: boolean | undefined;
  for (const op of ops) {
    const active = patchOpActive(op);
    if (active !== undefined) result = active;
  }
  return result;
}
