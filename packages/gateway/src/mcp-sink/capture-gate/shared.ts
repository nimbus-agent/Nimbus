import { CAPTURE_ROLE_BY_KIND } from "../capture-client-policy.ts";
import { type ActionPayload, CaptureError, type CaptureRow } from "../capture-types.ts";
import type { CaptureCaller, CaptureGateDeps, CaptureSummary } from "./contract.ts";

// ---- helpers shared by the gate's verbs and its owner reads --------------------------------------

export function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new CaptureError("ERR_CAPTURE_INVALID", "params must be an object");
  }
  return v as Record<string, unknown>;
}

export function requireOwner(caller: CaptureCaller): void {
  if (CAPTURE_ROLE_BY_KIND[caller.kind] !== "owner") {
    throw new CaptureError(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
      `a ${caller.kind} client cannot review captures`,
    );
  }
}

export function requireId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("cap_")) {
    throw new CaptureError("ERR_CAPTURE_INVALID", "id must be a capture id (cap_…)");
  }
  return raw;
}

export function missingItem(deps: CaptureGateDeps, ids: readonly string[]): string | undefined {
  for (const id of ids) {
    const exists = deps.db.query("SELECT 1 FROM item WHERE id = ?").get(id) !== null;
    if (!exists) return id;
    const st = deps.store.stateOfItem(id);
    if (st !== undefined && st !== "live" && st !== "accepted") return id;
  }
  return undefined;
}

export function titleOf(row: CaptureRow): string {
  if (row.payloadJson === null) return "(revoked)";
  const p = JSON.parse(row.payloadJson) as Record<string, unknown>;
  if (row.kind === "action") {
    const a = p as Partial<ActionPayload>;
    return `${String(a.actionType)}: ${String(a.summary)}`.slice(0, 120);
  }
  if (row.kind === "link") {
    const rel = typeof p["relation"] === "string" ? p["relation"] : "link";
    const from = typeof p["fromItemId"] === "string" ? p["fromItemId"] : "";
    const to = typeof p["toItemId"] === "string" ? p["toItemId"] : "";
    return `${rel}: ${from} → ${to}`.slice(0, 120);
  }
  const t = p["title"] ?? p["statement"] ?? p["term"];
  return typeof t === "string" ? t.slice(0, 120) : "";
}

export function summarize(row: CaptureRow): CaptureSummary {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    title: titleOf(row),
    clientLabel: row.clientLabel,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
  };
}
