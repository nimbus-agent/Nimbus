// Phase 7 (the Cost Pack, slice 12a): reading an Azure Cost Management FOCUS export (CSV) from Blob Storage over
// HTTPS with a bearer token (`_lib/azure-token.ts`); no `az` CLI.
//
// Layout, from Microsoft's "Create and manage exports"
// (https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-improved-exports):
//   <container>/<directory>/<export-name>/<YYYYMMDD-YYYYMMDD>/<run-id>/part_*.csv[.gz] + manifest.json
// The manifest's `blobs[].blobName` names the data files of that run. `[cost.azure].export.path` is
// `<directory>/<export-name>`. For each billing period the newest run that has a manifest is read.
//
// Blob requests: List Blobs (https://learn.microsoft.com/en-us/rest/api/storageservices/list-blobs; XML, `NextMarker`
// paging) and Get Blob (https://learn.microsoft.com/en-us/rest/api/storageservices/get-blob), both with
// `Authorization: Bearer` and the `x-ms-version` header OAuth requests must carry
// (https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-azure-active-directory). The service
// principal needs the "Storage Blob Data Reader" role on the container. Bodies are read as bytes, never as text.
//
// A period is read whole or not at all: any unreadable, refused or partial file makes the month a `month_gap`
// (nothing written). Every file must sit under the configured path. Pure of the store: it returns lines.
import type { CostLine } from "../finops/cost-line.ts";
import type { SyncContext } from "../sync/types.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import {
  AZURE_STORAGE_SCOPE,
  type AzureFetch,
  type AzureTokenResult,
  type AzureTokenSource,
} from "./_lib/azure-token.ts";
import {
  AWS_EXPORT_MAX_TEXT_BYTES,
  exportText,
  focusLinesFromText,
  monthGap,
} from "./aws-billing-export.ts";
import type { CostMonthOutcome } from "./cost-month-sync.ts";
import { RedirectRefusedError } from "./same-origin-fetch.ts";
import { asRecord } from "./unknown-record.ts";

export const AZURE_BILLING_SOURCE = "azure_billing";
export const AZURE_COST_PROVIDER = "azure";
export const AZURE_BLOB_API_VERSION = "2023-11-03";
export const AZURE_LIST_MAX_PAGES = 20;
const LIST_PAGE_SIZE = 5000;
export const AZURE_EXPORT_MAX_FILES = 200;
export const AZURE_BLOB_MAX_BYTES = 256 * 1024 * 1024;
export const AZURE_BLOB_TIMEOUT_MS = 5 * 60 * 1000;

export const AZURE_COST_GAPS = {
  notConfigured: "Azure cost is not configured: set [cost.azure] export, or scopes",
  scopesOnly:
    "Azure cost is not configured: [cost.azure] scopes are not read by this version; set [cost.azure] export",
  list: "the Azure cost export could not be listed (check the account, the container and the path)",
  access:
    "Azure refused the export container (the service principal needs the Storage Blob Data Reader role on it)",
  notFound: (account: string, container: string): string =>
    `the Azure storage account ${account} or its container ${container} was not found (check [cost.azure] export)`,
  spans: (folder: string): string =>
    `export folder ${folder} spans two months; use a monthly (month-to-date) export`,
  listCap: `the export holds more than ${String(AZURE_LIST_MAX_PAGES * LIST_PAGE_SIZE)} files under its path; point [cost.azure] export at the export's own folder`,
  empty:
    "no FOCUS export run with a manifest was found under the configured path (the first delivery can take up to 24 hours; check the path)",
  parquet: "the export is Parquet; recreate it as CSV",
  redirect: "Azure redirected the request to another host; the token is never sent there",
} as const;

export type BlobRef = { readonly name: string; readonly lastModified: number };
export type BlobListReply =
  | { readonly kind: "page"; readonly blobs: readonly BlobRef[]; readonly next: string | null }
  | { readonly kind: "gap"; readonly reason: string }
  | { readonly kind: "retry" };

/** What the sync needs of Blob Storage; a test passes a fake. */
export interface AzureBlobClient {
  list(prefix: string, marker: string | null): Promise<BlobListReply>;
  /** `transient`: the failure may pass (network, 429, 5xx), so the month is retried, not read from an older run. */
  download(
    name: string,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; transient: boolean }>;
}

const UNESCAPES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};
const unescapeXml = (s: string): string =>
  s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => UNESCAPES[m] ?? m);

/** The blobs and the next marker of one List Blobs page; null when the body is not an enumeration result. */
export function parseBlobList(xml: string): { blobs: BlobRef[]; next: string | null } | null {
  if (!xml.includes("<EnumerationResults")) return null;
  const blobs: BlobRef[] = [];
  for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
    const body = m[1] ?? "";
    // `<Name encoded="true">` (a name with characters XML cannot hold) is skipped: it can never be a CSV export file.
    const name = /<Name>([\s\S]*?)<\/Name>/.exec(body)?.[1];
    if (name === undefined) continue;
    const at = Date.parse(/<Last-Modified>([^<]*)<\/Last-Modified>/.exec(body)?.[1] ?? "");
    blobs.push({ name: unescapeXml(name), lastModified: Number.isNaN(at) ? 0 : at });
  }
  const marker = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1];
  return { blobs, next: marker === undefined ? null : unescapeXml(marker) };
}

const encodeBlobPath = (name: string): string => name.split("/").map(encodeURIComponent).join("/");

export function azureBlobClient(
  ctx: SyncContext,
  account: string,
  container: string,
  tokens: AzureTokenSource,
  fetchFn: AzureFetch,
): AzureBlobClient {
  const base = `https://${account}.blob.core.windows.net/${container}`;
  const penalise = (res: Response): void => {
    const sec = Number.parseInt(res.headers.get("retry-after") ?? "60", 10);
    ctx.rateLimiter.penalise("azure", Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000);
  };
  const drop = async (res: Response): Promise<void> => {
    await res.body?.cancel().catch(() => undefined);
  };
  /**
   * One authorised GET. A 401 (the token expired mid-run) drops the cached token, fetches a new one and sends the
   * request once more. A thrown fetch propagates to the caller.
   */
  async function send(
    url: string,
  ): Promise<{ res: Response } | Exclude<AzureTokenResult, { kind: "token" }>> {
    let t = await tokens.get(AZURE_STORAGE_SCOPE);
    for (let attempt = 0; ; attempt++) {
      if (t.kind !== "token") return t;
      await ctx.rateLimiter.acquire("azure"); // NOSONAR S9382: one request at a time
      const res = await fetchFn(url, {
        headers: { Authorization: `Bearer ${t.token}`, "x-ms-version": AZURE_BLOB_API_VERSION },
        signal: AbortSignal.timeout(AZURE_BLOB_TIMEOUT_MS),
      }); // NOSONAR S9382
      if (res.status !== 401 || attempt > 0) return { res };
      await drop(res); // NOSONAR S9382
      t = await tokens.refresh(AZURE_STORAGE_SCOPE); // NOSONAR S9382
    }
  }
  return {
    async list(prefix, marker) {
      const q = new URLSearchParams({
        restype: "container",
        comp: "list",
        prefix,
        maxresults: String(LIST_PAGE_SIZE),
      });
      if (marker !== null) q.set("marker", marker);
      let sent: Awaited<ReturnType<typeof send>>;
      try {
        sent = await send(`${base}?${q.toString()}`);
      } catch (e) {
        if (e instanceof RedirectRefusedError) {
          return { kind: "gap", reason: AZURE_COST_GAPS.redirect };
        }
        // The first request never reached the account (DNS, connect): the account name is wrong or does not exist.
        return marker === null
          ? { kind: "gap", reason: AZURE_COST_GAPS.notFound(account, container) }
          : { kind: "retry" };
      }
      if (!("res" in sent)) return sent;
      const { res } = sent;
      if (res.status === 429) penalise(res);
      if (res.status === 401 || res.status === 403) {
        await drop(res);
        return { kind: "gap", reason: AZURE_COST_GAPS.access };
      }
      if (res.status === 404) {
        await drop(res);
        return { kind: "gap", reason: AZURE_COST_GAPS.notFound(account, container) };
      }
      if (!res.ok) {
        await drop(res);
        // 429 and 5xx are transient; any other status is a request Azure will keep refusing.
        return res.status === 429 || res.status >= 500
          ? { kind: "retry" }
          : { kind: "gap", reason: AZURE_COST_GAPS.list };
      }
      try {
        // The XML is read as bytes and decoded once; a listing holds names only.
        const parsed = parseBlobList(new TextDecoder().decode(await res.arrayBuffer()));
        return parsed === null
          ? { kind: "gap", reason: AZURE_COST_GAPS.list }
          : { kind: "page", ...parsed };
      } catch {
        return { kind: "retry" };
      }
    },
    async download(name) {
      try {
        const sent = await send(`${base}/${encodeBlobPath(name)}`);
        if (!("res" in sent)) return { ok: false, transient: sent.kind === "retry" };
        const { res } = sent;
        if (res.status === 429) penalise(res);
        if (!res.ok) {
          await drop(res);
          return { ok: false, transient: res.status === 429 || res.status >= 500 };
        }
        return await readCapped(res);
      } catch {
        return { ok: false, transient: true };
      }
    },
  };
}

/**
 * The body, streamed and counted: it is cancelled the moment it passes {@link AZURE_BLOB_MAX_BYTES}, so the cap
 * holds with no Content-Length, a wrong one, or chunked encoding. A Content-Length that is a finite number over the
 * cap is refused early; a missing or non-numeric one is not trusted and not needed.
 */
async function readCapped(
  res: Response,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; transient: boolean }> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > AZURE_BLOB_MAX_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, transient: false };
  }
  if (res.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); // NOSONAR S9382: a stream is read in order
    if (done) break;
    total += value.byteLength;
    if (total > AZURE_BLOB_MAX_BYTES) {
      await reader.cancel().catch(() => undefined); // NOSONAR S9382
      return { ok: false, transient: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes };
}

export type ExportRef = { readonly manifest: string };
export type ExportListing =
  | {
      readonly kind: "listing";
      /** Per billing month, its runs that have a manifest, newest first. */
      readonly periods: ReadonlyMap<string, readonly ExportRef[]>;
      /** Per month, a date-range folder that spans two months (not read), by folder name. */
      readonly spanning: ReadonlyMap<string, string>;
    }
  | { readonly kind: "gap"; readonly reason: string }
  | { readonly kind: "retry" };

const RUN_RE = /^(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})\/([^/]+)\/(.+)$/;
const MANIFEST_RE = /(?:^|\/)_?manifest\.json$/i;

type Run = { manifest: string; lastModified: number };

/** Newest first. */
function newestFirst(a: Run, b: Run): number {
  return a.lastModified === b.lastModified
    ? codeUnitCompare(b.manifest, a.manifest)
    : b.lastModified - a.lastModified;
}

/** Every blob under the export path, and from them each billing month's runs with a manifest, newest first. */
export async function listAzureExport(
  client: AzureBlobClient,
  path: string,
): Promise<ExportListing> {
  const keyPrefix = `${path}/`;
  const runs = new Map<string, Run[]>();
  const spanning = new Map<string, string>();
  let marker: string | null = null;
  for (let page = 0; page < AZURE_LIST_MAX_PAGES; page++) {
    const r: BlobListReply = await client.list(keyPrefix, marker); // NOSONAR S9382: one request at a time
    if (r.kind !== "page") return r;
    for (const b of r.blobs) {
      if (!b.name.startsWith(keyPrefix) || !MANIFEST_RE.test(b.name)) continue;
      const m = RUN_RE.exec(b.name.slice(keyPrefix.length));
      if (m === null) continue;
      if (m[1] !== m[4] || m[2] !== m[5]) {
        // A range that starts in one month and ends in another is not one billing month: recorded, not read.
        const name = b.name.slice(keyPrefix.length).split("/")[0] ?? "";
        spanning.set(`${m[1] ?? ""}-${m[2] ?? ""}`, name);
        spanning.set(`${m[4] ?? ""}-${m[5] ?? ""}`, name);
        continue;
      }
      const month = `${m[1] ?? ""}-${m[2] ?? ""}`;
      const run: Run = { manifest: b.name, lastModified: b.lastModified };
      const held = runs.get(month);
      if (held === undefined) runs.set(month, [run]);
      else held.push(run);
    }
    if (r.next === null) {
      if (runs.size === 0 && spanning.size === 0) {
        return { kind: "gap", reason: AZURE_COST_GAPS.empty };
      }
      const periods = new Map<string, readonly ExportRef[]>();
      for (const [month, rs] of runs) {
        periods.set(
          month,
          [...rs].sort(newestFirst).map((x) => ({ manifest: x.manifest })),
        );
      }
      return { kind: "listing", periods, spanning };
    }
    if (r.next === marker) return { kind: "gap", reason: AZURE_COST_GAPS.list };
    marker = r.next;
  }
  return { kind: "gap", reason: AZURE_COST_GAPS.listCap };
}

/** The data files a manifest names, each checked to sit under the configured path. */
function manifestFiles(text: string, path: string, month: string): string[] | CostMonthOutcome {
  let rec: Record<string, unknown> | undefined;
  try {
    rec = asRecord(JSON.parse(text) as unknown);
  } catch {
    rec = undefined;
  }
  const blobs = rec === undefined ? undefined : rec["blobs"];
  const names: string[] = [];
  if (Array.isArray(blobs)) {
    for (const b of blobs) {
      const n = asRecord(b)?.["blobName"];
      if (typeof n === "string") names.push(n.trim());
    }
  }
  if (!Array.isArray(blobs) || blobs.length === 0 || names.length !== blobs.length) {
    return monthGap(`the ${month} export manifest lists no data files; that month was not updated`);
  }
  const root = `${path}/`;
  if (names.some((n) => !n.startsWith(root) || n.split("/").includes(".."))) {
    return monthGap(
      `the ${month} export manifest names a file outside ${root}; that month was not updated`,
    );
  }
  if (names.some((n) => n.toLowerCase().endsWith(".parquet"))) {
    return { kind: "gap", reason: AZURE_COST_GAPS.parquet };
  }
  if (names.length > AZURE_EXPORT_MAX_FILES) {
    return monthGap(
      `the ${month} export has more than ${String(AZURE_EXPORT_MAX_FILES)} files; that month was not updated`,
    );
  }
  return names;
}

/**
 * One run's lines, re-sourced to `azure_billing`, or why they cannot be written: an account gap (Parquet), a
 * `retry` (a transient download failure) or a `month_gap` (anything unreadable, partial, empty or refused).
 */
export async function readAzureExportRun(
  client: AzureBlobClient,
  path: string,
  ref: ExportRef,
  month: string,
  maxTextBytes?: number,
): Promise<CostLine[] | CostMonthOutcome> {
  let transient = false;
  const reading: RunDownload = {
    download: async (name) => {
      const got = await client.download(name);
      if (!got.ok && got.transient) transient = true;
      return got.ok ? got : { ok: false };
    },
  };
  const outcome = await readRun(reading, path, ref, month, maxTextBytes);
  return transient && !Array.isArray(outcome) ? { kind: "retry" } : outcome;
}

type RunDownload = {
  download(url: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }>;
};

async function readRun(
  client: RunDownload,
  path: string,
  ref: ExportRef,
  month: string,
  maxTextBytes?: number,
): Promise<CostLine[] | CostMonthOutcome> {
  const manifest = await client.download(ref.manifest);
  if (!manifest.ok) {
    return monthGap(`the ${month} export manifest could not be read; that month was not updated`);
  }
  const names = manifestFiles(new TextDecoder().decode(manifest.bytes), path, month);
  if (!Array.isArray(names)) return names;
  const text = await exportText(client, names, month, maxTextBytes ?? AWS_EXPORT_MAX_TEXT_BYTES);
  if (typeof text !== "string") return text;
  return focusLinesFromText(text, AZURE_COST_PROVIDER, AZURE_BILLING_SOURCE, month);
}

/** How many runs of one month are tried, newest first, before the month is a gap. */
export const AZURE_MAX_RUNS_TRIED = 5;

/**
 * One billing month's lines from the newest run whose parts ALL download and parse; an older complete run is used
 * when a newer one is partial. Only when no run is complete is it a `month_gap` (the newest run's reason). A
 * transient failure or an account gap stops the search at once (an older run must not stand in for a retry).
 */
export async function readAzureExportMonth(
  client: AzureBlobClient,
  path: string,
  refs: readonly ExportRef[],
  month: string,
  maxTextBytes?: number,
): Promise<CostLine[] | CostMonthOutcome> {
  let firstGap: CostMonthOutcome | null = null;
  for (const ref of refs.slice(0, AZURE_MAX_RUNS_TRIED)) {
    const out = await readAzureExportRun(client, path, ref, month, maxTextBytes); // NOSONAR S9382: newest first, one at a time
    if (Array.isArray(out)) return out;
    if (out.kind !== "month_gap") return out;
    firstGap ??= out;
  }
  return firstGap ?? monthGap(`the ${month} export has no run to read; that month was not updated`);
}
