import type {
  IncidentGetResult,
  IncidentListResult,
  IncidentTimelineResult,
} from "../../ipc/types";
import { isRecord } from "./safe";

/** Shallow: the gateway's own tests pin the full shapes. `null` = not this shape (yet). */
export function asIncidentList(v: unknown): IncidentListResult | null {
  if (!isRecord(v) || !Array.isArray(v["records"]) || typeof v["status"] !== "string") return null;
  return v as unknown as IncidentListResult;
}

export function asIncidentGet(v: unknown): IncidentGetResult | null {
  if (!isRecord(v) || !("record" in v)) return null;
  const r = v["record"];
  if (r === null) return v as unknown as IncidentGetResult;
  return isRecord(r) &&
    isRecord(r["summary"]) &&
    typeof r["markdown"] === "string" &&
    Array.isArray(r["versions"])
    ? (v as unknown as IncidentGetResult)
    : null;
}

export function asIncidentTimeline(v: unknown): IncidentTimelineResult | null {
  if (
    !isRecord(v) ||
    !Array.isArray(v["events"]) ||
    !Array.isArray(v["notes"]) ||
    typeof v["recordId"] !== "string"
  )
    return null;
  return v as unknown as IncidentTimelineResult;
}
