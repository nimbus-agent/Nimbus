import { serviceOf } from "../engine/service-of.ts";
import { EXTENSION_SERVICE_ID_PATTERN } from "../extensions/extension-service-id.ts";
import { USER_MCP_SERVICE_ID_PATTERN } from "./user-mcp-store.ts";

/**
 * I42: an "owner-approved code server" is a process that runs code the owner approved but whose
 * tools are not enumerable ahead of time — a user-registered MCP server (`mcp_*`) or an approved
 * extension (`ext_*`). The two id patterns are disjoint from each other and from every first-party
 * connector id, so these predicates key on the id prefix alone (derived from the action TYPE, I3).
 */
export function isOwnerCodeServerServiceId(id: string): boolean {
  return USER_MCP_SERVICE_ID_PATTERN.test(id) || EXTENSION_SERVICE_ID_PATTERN.test(id);
}

/** True when a dispatcher tool key belongs to an owner code server (`mcp_` or `ext_` prefix). */
export function isOwnerCodeServerToolKey(key: string): boolean {
  return key.startsWith("mcp_") || key.startsWith("ext_");
}

/**
 * The ONE tool key an owner-code-server action type may dispatch: `<serviceId>.<tool>` ->
 * `<serviceId>_<tool>`. `undefined` when the type's service is not such a server or names no tool.
 */
export function ownerCodeServerToolKeyForActionType(actionType: string): string | undefined {
  const dot = actionType.indexOf(".");
  if (dot <= 0 || dot === actionType.length - 1) return undefined;
  const serviceId = serviceOf(actionType);
  if (!isOwnerCodeServerServiceId(serviceId)) return undefined;
  return `${serviceId}_${actionType.slice(dot + 1)}`;
}

export function normalizeOwnerCodeServerServiceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return isOwnerCodeServerServiceId(s) ? s : null;
}
