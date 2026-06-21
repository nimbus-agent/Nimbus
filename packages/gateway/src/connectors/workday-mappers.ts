import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { WorkdayReport } from "../config/nimbus-toml-workday.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord } from "./unknown-record.ts";
import {
  applyReportFieldPolicy,
  isPiiKey,
  JOB_POSTING_ALLOWED_FIELDS,
  pickAllowed,
  TIME_OFF_ALLOWED_FIELDS,
  WORKER_ALLOWED_FIELDS,
} from "./workday-field-allowlist.ts";

export interface WorkdayMapContext {
  readonly syncedAt: number;
  readonly tenantHost: string;
  readonly tenant: string;
}

export type WorkdayMappedRow = MappedRow<
  "workday",
  "worker" | "time_off" | "job_posting" | "report"
>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function workerCanonicalUrl(ctx: WorkdayMapContext, id: string): string {
  return `${ctx.tenantHost.replace(/\/$/, "")}/${encodeURIComponent(ctx.tenant)}/d/inst/1$37/${encodeURIComponent(id)}.htmld`;
}

function stableRowKey(row: Record<string, unknown>): string {
  const sorted = Object.keys(row)
    .sort()
    .map((k) => `${k}=${String(row[k])}`)
    .join("");
  return bytesToHex(blake3(new TextEncoder().encode(sorted))).slice(0, 32);
}

export function mapWorkerToItem(raw: unknown, ctx: WorkdayMapContext): WorkdayMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const id = str(row["id"]) ?? str(row["workerId"]);
  if (id === undefined) return null;
  const name = str(row["name"]) ?? str(row["descriptor"]) ?? `Worker ${id}`;
  const canonicalUrl = workerCanonicalUrl(ctx, id);
  const metadata = pickAllowed({ ...row, canonicalUrl }, WORKER_ALLOWED_FIELDS);
  const preview = [str(row["title"]), str(row["team"]), str(row["location"])]
    .filter((s): s is string => s !== undefined)
    .join(" · ");
  return {
    service: "workday",
    type: "worker",
    externalId: id,
    title: name,
    bodyPreview: preview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt: ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}

export function mapTimeOffToItem(raw: unknown, ctx: WorkdayMapContext): WorkdayMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const id = str(row["id"]);
  if (id === undefined) return null;
  const type = str(row["type"]) ?? "Time Off";
  const startDate = str(row["startDate"]) ?? "";
  const canonicalUrl = workerCanonicalUrl(ctx, id);
  const metadata = pickAllowed({ ...row, canonicalUrl }, TIME_OFF_ALLOWED_FIELDS);
  return {
    service: "workday",
    type: "time_off",
    externalId: id,
    title: `${type} ${startDate}`.trim(),
    bodyPreview: [str(row["worker"]), str(row["status"])]
      .filter((s): s is string => s !== undefined)
      .join(" · "),
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt: ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}

export function mapJobPostingToItem(raw: unknown, ctx: WorkdayMapContext): WorkdayMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const id = str(row["id"]) ?? str(row["reqId"]);
  if (id === undefined) return null;
  const title = str(row["title"]) ?? `Job Posting ${id}`;
  const canonicalUrl = workerCanonicalUrl(ctx, id);
  const metadata = pickAllowed({ ...row, canonicalUrl }, JOB_POSTING_ALLOWED_FIELDS);
  return {
    service: "workday",
    type: "job_posting",
    externalId: id,
    title,
    bodyPreview: [str(row["team"]), str(row["location"]), str(row["status"])]
      .filter((s): s is string => s !== undefined)
      .join(" · "),
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt: ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}

export function mapReportRowToItem(
  raw: unknown,
  report: WorkdayReport,
  ctx: WorkdayMapContext,
): WorkdayMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;
  const filtered = applyReportFieldPolicy(row, report.fields);
  const keyVal =
    report.keyField !== undefined &&
    typeof row[report.keyField] === "string" &&
    !isPiiKey(report.keyField)
      ? (row[report.keyField] as string)
      : stableRowKey(filtered);
  const externalId = `${report.label}:${keyVal}`;
  const bodyPreview = Object.entries(filtered)
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ");
  return {
    service: "workday",
    type: "report",
    externalId,
    title: `${report.label} — ${keyVal}`,
    bodyPreview,
    url: report.url,
    canonicalUrl: report.url,
    modifiedAt: ctx.syncedAt,
    metadata: { reportLabel: report.label, ...filtered },
    syncedAt: ctx.syncedAt,
  };
}
