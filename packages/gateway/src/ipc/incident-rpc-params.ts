import type { Database } from "bun:sqlite";

import { resolveIncidentRef } from "../incident/incident-id.ts";
import { IncidentRpcError } from "./incident-rpc.ts";

/**
 * Parameter checks shared by the incident namespace's owner RPC modules (`postmortem-rpc.ts`, IC7a;
 * `incident-update-rpc.ts`, IC9b). Every failure is a `-32602` `IncidentRpcError`; a record reference resolves to a
 * STORED record or a typed error, never a guess.
 */

export function requireKeys(
  method: string,
  params: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new IncidentRpcError(-32602, `${method} requires an object payload`);
  }
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!allowed.includes(key)) {
      throw new IncidentRpcError(-32602, `${method}: unknown parameter "${key}"`);
    }
  }
  return p;
}

export function stringParam(
  method: string,
  p: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const v = p[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "" || v.length > max) {
    throw new IncidentRpcError(-32602, `${method}: ${key} must be a non-empty string`);
  }
  return v;
}

/** The record a person's reference names, or a typed error (never an answer about a record that is not stored). */
export function recordIdFor(db: Database, method: string, p: Record<string, unknown>): string {
  const id = stringParam(method, p, "id", 256)?.trim();
  if (id === undefined) {
    throw new IncidentRpcError(-32602, `${method}: id must be a non-empty string`);
  }
  const ref = resolveIncidentRef(db, id);
  if (ref.kind === "record") return ref.recordId;
  if (ref.kind === "ambiguous") {
    throw new IncidentRpcError(
      -32602,
      `ERR_INCIDENT_AMBIGUOUS: that id names more than one item (${ref.candidates.join(", ")}); use the full item id`,
    );
  }
  if (ref.kind === "not_a_trigger") {
    throw new IncidentRpcError(
      -32602,
      `ERR_INCIDENT_NOT_A_TRIGGER: ${ref.itemId} is not a trigger`,
    );
  }
  throw new IncidentRpcError(
    -32602,
    "ERR_INCIDENT_NOT_FOUND: no record is stored for that id (show the incident first so it is assembled)",
  );
}
