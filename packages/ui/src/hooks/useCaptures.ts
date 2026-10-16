import type { CaptureDetail, CaptureList } from "../ipc/types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Shallow: the fixture-backed contract test pins the full shape on the gateway side. */
export function asCaptureList(v: unknown): CaptureList | null {
  if (!isRecord(v) || !Array.isArray(v["captures"])) return null;
  return v as unknown as CaptureList;
}

/** Shallow, like {@link asCaptureList}; `null` = nothing usable yet (loading, or not this shape). */
export function asCaptureDetail(v: unknown): CaptureDetail | null {
  if (!isRecord(v) || typeof v["id"] !== "string" || typeof v["state"] !== "string") return null;
  return v as unknown as CaptureDetail;
}
