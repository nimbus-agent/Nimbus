import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "../../nimbus-json-cursor.ts";

export const GMAIL_CURSOR_PREFIX = "nimbus-gml1:";

export type GmailSyncCursorV1 =
  | { v: 1; phase: "list"; q: string; pageToken: string | null }
  | { v: 1; phase: "delta"; startHistoryId: string; pageToken: string | null };

export function encodeGmailSyncCursor(c: GmailSyncCursorV1): string {
  return encodeNimbusJsonCursor(GMAIL_CURSOR_PREFIX, c);
}

function decodeGmailListPhasePayload(r: Record<string, unknown>): GmailSyncCursorV1 | undefined {
  const q = r["q"];
  const pageToken = r["pageToken"];
  if (typeof q !== "string") {
    return undefined;
  }
  if (pageToken !== null && typeof pageToken !== "string") {
    return undefined;
  }
  return { v: 1, phase: "list", q, pageToken };
}

function decodeGmailDeltaPhasePayload(r: Record<string, unknown>): GmailSyncCursorV1 | undefined {
  const startHistoryId = r["startHistoryId"];
  const pageToken = r["pageToken"];
  if (typeof startHistoryId !== "string" || startHistoryId === "") {
    return undefined;
  }
  if (pageToken !== null && typeof pageToken !== "string") {
    return undefined;
  }
  return {
    v: 1,
    phase: "delta",
    startHistoryId,
    pageToken,
  };
}

export function decodeGmailSyncCursor(raw: string): GmailSyncCursorV1 | undefined {
  const o = decodeNimbusJsonCursorPayload(raw, GMAIL_CURSOR_PREFIX);
  if (o == null || typeof o !== "object" || Array.isArray(o)) {
    return undefined;
  }
  const r = o as Record<string, unknown>;
  if (r["v"] !== 1) {
    return undefined;
  }
  const phase = r["phase"];
  if (phase === "list") {
    return decodeGmailListPhasePayload(r);
  }
  if (phase === "delta") {
    return decodeGmailDeltaPhasePayload(r);
  }
  return undefined;
}
