// Phase 7 (the Cost Pack, slice 11a): reading an AWS Data Export (FOCUS 1.0, CSV) from S3 through the AWS CLI.
//
// Layout, from AWS's "Understanding export delivery" and "Data Exports manifest file reference"
// (https://docs.aws.amazon.com/cur/latest/userguide/dataexports-export-delivery.html,
// https://docs.aws.amazon.com/cur/latest/userguide/dataexports-manifest.html):
//   s3://<bucket>/<prefix>/<export-name>/metadata/BILLING_PERIOD=YYYY-MM/<export-name>-Manifest.json
//   (create-new mode also keeps one per run under metadata/BILLING_PERIOD=YYYY-MM/<timestamp>-<execution-id>/)
//   and the manifest's `dataFiles` lists the data files as full s3:// URIs (`<export-name>-00001.csv.gz`, ...).
// The newest manifest of a billing period names the files of its latest refresh, so that is the one read. The
// prefix must hold ONE export; two export names under it are a stated gap (their lines would be added together).
//
// A period is read whole or not at all: any unreadable, refused or partial file makes the month a `month_gap`
// (nothing written). Every file must sit under the configured bucket and prefix, so the credentials are never
// used for another location. Pure of the store: it returns lines; `aws-billing-cost-sync.ts` writes them.
import type { CostLine } from "../finops/cost-line.ts";
import { FocusCsvError, parseFocusCsv } from "../finops/focus-csv.ts";
import { focusFileText } from "../finops/focus-file-text.ts";
import type { SyncContext } from "../sync/types.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import {
  awsCliDownload,
  awsCliJson,
  awsNextToken,
  extractArray,
  parseJson,
} from "./_lib/aws-cli.ts";
import type { CostMonthOutcome } from "./cost-month-sync.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export const AWS_BILLING_SOURCE = "aws_billing";
export const AWS_COST_PROVIDER = "aws";
/** Listing pages of 5,000 keys; past this many the export is too large to list and the account shows a gap. */
export const AWS_LIST_MAX_PAGES = 20;
const LIST_PAGE_SIZE = 5000;
export const AWS_EXPORT_MAX_FILES = 200;
/** All files of one period together; a larger period is a `month_gap`, never a partial write. */
export const AWS_EXPORT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export const AWS_COST_GAPS = {
  notConfigured: "AWS cost is not configured: set [cost.aws] export, or cost_explorer = true",
  costExplorerOnly:
    "AWS cost is not configured: [cost.aws] cost_explorer is not read by this version; set [cost.aws] export",
  list: "the AWS cost export could not be listed (check the bucket name, the prefix and the AWS credentials)",
  listCap: `the export holds more than ${String(AWS_LIST_MAX_PAGES * LIST_PAGE_SIZE)} files under its prefix; point [cost.aws] export at the export's own folder`,
  empty:
    "no FOCUS export manifest was found under the configured prefix (the first delivery can take up to 24 hours; check the path)",
  severalExports:
    "the configured prefix holds more than one export; set [cost.aws] export to one export's folder",
  parquet: "the export is Parquet; recreate it as CSV",
} as const;

/** What the sync needs of the AWS CLI; the credentials are bound in, and a test passes a fake. */
export interface AwsBillingCli {
  list(
    bucket: string,
    prefix: string,
    token: string | null,
  ): Promise<{ ok: boolean; text: string }>;
  download(s3Url: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }>;
}

export function awsBillingCli(ctx: SyncContext, extra: Record<string, string>): AwsBillingCli {
  return {
    list: (bucket, prefix, token) =>
      awsCliJson(ctx, [
        "s3api",
        "list-objects-v2",
        "--bucket",
        bucket,
        "--prefix",
        prefix,
        "--max-items",
        String(LIST_PAGE_SIZE),
        ...(token === null ? [] : ["--starting-token", token]),
      ]),
    download: (url) => awsCliDownload(url, extra),
  };
}

export type ManifestRef = { readonly key: string; readonly lastModified: number };
export type ExportListing =
  | { readonly kind: "listing"; readonly periods: ReadonlyMap<string, ManifestRef> }
  | { readonly kind: "gap"; readonly reason: string };

const MANIFEST_RE =
  /(?:^|\/)metadata\/BILLING_PERIOD=(\d{4}-(?:0[1-9]|1[0-2]))\/(?:[^/]+\/)?[^/]*Manifest\.json$/i;

function newer(a: ManifestRef, b: ManifestRef): boolean {
  return a.lastModified !== b.lastModified
    ? a.lastModified > b.lastModified
    : codeUnitCompare(a.key, b.key) > 0;
}

/** Every key under the export prefix, and from them the newest manifest of each billing period. */
export async function listExport(
  ctx: SyncContext,
  cli: AwsBillingCli,
  bucket: string,
  prefix: string,
): Promise<ExportListing> {
  const keyPrefix = prefix === "" ? "" : `${prefix}/`;
  const periods = new Map<string, ManifestRef>();
  const exportDirs = new Set<string>();
  let token: string | null = null;
  for (let page = 0; page < AWS_LIST_MAX_PAGES; page++) {
    await ctx.rateLimiter.acquire("aws"); // NOSONAR S9382: one CLI call at a time through the AWS limiter
    const res = await cli.list(bucket, keyPrefix, token); // NOSONAR S9382
    const parsed = res.ok ? parseJson(res.text) : undefined;
    if (parsed === undefined) return { kind: "gap", reason: AWS_COST_GAPS.list };
    for (const entry of extractArray(parsed, "Contents")) {
      const rec = asRecord(entry);
      const key = rec === undefined ? undefined : stringField(rec, "Key");
      const m = key === undefined ? null : MANIFEST_RE.exec(key);
      if (key === undefined || m === null || !key.startsWith(keyPrefix)) continue;
      const period = m[1] ?? "";
      const at = Date.parse(stringField(rec ?? {}, "LastModified") ?? "");
      const ref: ManifestRef = { key, lastModified: Number.isNaN(at) ? 0 : at };
      exportDirs.add(key.slice(0, key.toLowerCase().lastIndexOf("/metadata/")));
      const held = periods.get(period);
      if (held === undefined || newer(ref, held)) periods.set(period, ref);
    }
    const next = awsNextToken(parsed, "NextToken");
    if (next === null) {
      if (exportDirs.size === 0) return { kind: "gap", reason: AWS_COST_GAPS.empty };
      if (exportDirs.size > 1) return { kind: "gap", reason: AWS_COST_GAPS.severalExports };
      return { kind: "listing", periods };
    }
    if (next === token) return { kind: "gap", reason: AWS_COST_GAPS.list };
    token = next;
  }
  return { kind: "gap", reason: AWS_COST_GAPS.listCap };
}

const monthGap = (reason: string): CostMonthOutcome => ({ kind: "month_gap", reason });
const short = (s: string): string => s.slice(0, 120);

/** The data files a manifest names, each checked to sit under the configured bucket and prefix. */
function manifestFiles(
  text: string,
  bucket: string,
  prefix: string,
  month: string,
): string[] | CostMonthOutcome {
  const rec = asRecord(parseJson(text));
  const files = rec === undefined ? undefined : rec["dataFiles"];
  if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === "string")) {
    return monthGap(`the ${month} export manifest lists no data files; that month was not updated`);
  }
  const root = `s3://${bucket}/${prefix === "" ? "" : `${prefix}/`}`;
  const urls = files as string[];
  if (urls.some((u) => !u.startsWith(root) || u.split("/").includes(".."))) {
    return monthGap(
      `the ${month} export manifest names a file outside ${root}; that month was not updated`,
    );
  }
  if (urls.some((u) => u.toLowerCase().endsWith(".parquet"))) {
    return { kind: "gap", reason: AWS_COST_GAPS.parquet };
  }
  if (urls.length > AWS_EXPORT_MAX_FILES) {
    return monthGap(
      `the ${month} export has more than ${String(AWS_EXPORT_MAX_FILES)} files; that month was not updated`,
    );
  }
  return urls;
}

const isOutcome = (v: unknown): v is CostMonthOutcome => !Array.isArray(v);

const firstLine = (text: string): string => {
  const t = text.startsWith("﻿") ? text.slice(1) : text;
  const i = t.indexOf("\n");
  return (i === -1 ? t : t.slice(0, i)).trim();
};

/** Every data file, decoded and joined under ONE header; an empty chunk is skipped, a differing header refused. */
async function exportText(
  cli: AwsBillingCli,
  urls: readonly string[],
  month: string,
): Promise<string | CostMonthOutcome> {
  const parts: string[] = [];
  let header: string | null = null;
  let total = 0;
  for (const url of urls) {
    const got = await cli.download(url); // NOSONAR S9382: one file at a time
    if (!got.ok)
      return monthGap(`a ${month} export file could not be read; that month was not updated`);
    total += got.bytes.byteLength;
    if (total > AWS_EXPORT_MAX_TOTAL_BYTES) {
      return monthGap(
        `the ${month} export is larger than the read cap; that month was not updated`,
      );
    }
    let text: string;
    try {
      text = focusFileText(got.bytes, url);
    } catch (e) {
      return monthGap(
        `${short(e instanceof Error ? e.message : String(e))}; ${month} was not updated`,
      );
    }
    if (text.trim() === "") continue; // Data Exports overwrites surplus chunks with empty data
    const h = firstLine(text);
    if (header !== null && h !== header) {
      return monthGap(
        `the ${month} export files have different headers; that month was not updated`,
      );
    }
    header ??= h;
    parts.push(header === h && parts.length > 0 ? text.slice(text.indexOf("\n") + 1) : text);
  }
  if (parts.length === 0) {
    return monthGap(`the ${month} export files are empty; that month was not updated`);
  }
  return parts.map((p) => (p.endsWith("\n") ? p : `${p}\n`)).join("");
}

/**
 * One billing period's lines, re-sourced to `aws_billing`, or why they cannot be written: an account gap (Parquet)
 * or a `month_gap` (anything unreadable, partial, empty or refused: a stored month is never cleared by one).
 */
export async function readExportMonth(
  cli: AwsBillingCli,
  bucket: string,
  prefix: string,
  ref: ManifestRef,
  month: string,
): Promise<CostLine[] | CostMonthOutcome> {
  const manifest = await cli.download(`s3://${bucket}/${ref.key}`);
  if (!manifest.ok)
    return monthGap(`the ${month} export manifest could not be read; that month was not updated`);
  const urls = manifestFiles(new TextDecoder().decode(manifest.bytes), bucket, prefix, month);
  if (isOutcome(urls)) return urls;
  const text = await exportText(cli, urls, month);
  if (typeof text !== "string") return text;
  let parsed: ReturnType<typeof parseFocusCsv>;
  try {
    parsed = parseFocusCsv(text, {
      provider: AWS_COST_PROVIDER,
      importId: `${AWS_BILLING_SOURCE}:${month}`,
    });
  } catch (e) {
    const why = e instanceof FocusCsvError ? e.message : String(e);
    return monthGap(
      `the ${month} export is not a FOCUS CSV (${short(why)}); that month was not updated`,
    );
  }
  if (parsed.skipped.length > 0) {
    return monthGap(
      `${String(parsed.skipped.length)} rows of the ${month} export could not be read; that month was not updated`,
    );
  }
  const stray = parsed.lines.filter(
    (l) => l.billingPeriod !== month || l.billingAccountId === "",
  ).length;
  if (stray > 0 || parsed.lines.length === 0) {
    return monthGap(
      `the ${month} export has ${stray > 0 ? `${String(stray)} rows outside the period or with no BillingAccountId` : "no rows"}; that month was not updated`,
    );
  }
  return parsed.lines.map((l) => ({ ...l, source: AWS_BILLING_SOURCE }));
}
