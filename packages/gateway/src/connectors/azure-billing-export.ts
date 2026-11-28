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
import { AZURE_STORAGE_SCOPE, type AzureFetch, type AzureTokenSource } from "./_lib/azure-token.ts";
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
  list: "the Azure cost export could not be listed (check the account, the container and the path)",
  access:
    "Azure refused the export container (the service principal needs the Storage Blob Data Reader role on it)",
  notFound: "the Azure storage account or container was not found",
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
  download(name: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }>;
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
  const headers = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    "x-ms-version": AZURE_BLOB_API_VERSION,
  });
  return {
    async list(prefix, marker) {
      const t = await tokens.get(AZURE_STORAGE_SCOPE);
      if (t.kind !== "token") return t;
      const q = new URLSearchParams({
        restype: "container",
        comp: "list",
        prefix,
        maxresults: String(LIST_PAGE_SIZE),
      });
      if (marker !== null) q.set("marker", marker);
      await ctx.rateLimiter.acquire("azure");
      let res: Response;
      try {
        res = await fetchFn(`${base}?${q.toString()}`, {
          headers: headers(t.token),
          signal: AbortSignal.timeout(AZURE_BLOB_TIMEOUT_MS),
        });
      } catch (e) {
        return e instanceof RedirectRefusedError
          ? { kind: "gap", reason: AZURE_COST_GAPS.redirect }
          : { kind: "retry" };
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "gap", reason: AZURE_COST_GAPS.access };
      }
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "gap", reason: AZURE_COST_GAPS.notFound };
      }
      if (res.status === 429) {
        const sec = Number.parseInt(res.headers.get("retry-after") ?? "60", 10);
        ctx.rateLimiter.penalise("azure", Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "retry" };
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
      const t = await tokens.get(AZURE_STORAGE_SCOPE);
      if (t.kind !== "token") return { ok: false };
      await ctx.rateLimiter.acquire("azure");
      try {
        const res = await fetchFn(`${base}/${encodeBlobPath(name)}`, {
          headers: headers(t.token),
          signal: AbortSignal.timeout(AZURE_BLOB_TIMEOUT_MS),
        });
        if (res.status === 429) {
          const sec = Number.parseInt(res.headers.get("retry-after") ?? "60", 10);
          ctx.rateLimiter.penalise("azure", Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000);
        }
        const declared = Number(res.headers.get("content-length") ?? "0");
        if (!res.ok || declared > AZURE_BLOB_MAX_BYTES) {
          await res.body?.cancel().catch(() => undefined);
          return { ok: false };
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        return bytes.byteLength > AZURE_BLOB_MAX_BYTES ? { ok: false } : { ok: true, bytes };
      } catch {
        return { ok: false };
      }
    },
  };
}

export type ExportRef = { readonly manifest: string };
export type ExportListing =
  | { readonly kind: "listing"; readonly periods: ReadonlyMap<string, ExportRef> }
  | { readonly kind: "gap"; readonly reason: string }
  | { readonly kind: "retry" };

const RUN_RE = /^(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})\/([^/]+)\/(.+)$/;
const MANIFEST_RE = /(?:^|\/)_?manifest\.json$/i;

type Run = { manifest: string; lastModified: number };

function newer(a: Run, b: Run): boolean {
  return a.lastModified !== b.lastModified
    ? a.lastModified > b.lastModified
    : codeUnitCompare(a.manifest, b.manifest) > 0;
}

/** Every blob under the export path, and from them the newest run with a manifest of each billing month. */
export async function listAzureExport(
  client: AzureBlobClient,
  path: string,
): Promise<ExportListing> {
  const keyPrefix = `${path}/`;
  const periods = new Map<string, Run>();
  let marker: string | null = null;
  for (let page = 0; page < AZURE_LIST_MAX_PAGES; page++) {
    const r: BlobListReply = await client.list(keyPrefix, marker); // NOSONAR S9382: one request at a time
    if (r.kind !== "page") return r;
    for (const b of r.blobs) {
      if (!b.name.startsWith(keyPrefix) || !MANIFEST_RE.test(b.name)) continue;
      const m = RUN_RE.exec(b.name.slice(keyPrefix.length));
      if (m === null) continue;
      // A range that starts on one month and ends in another is not one billing month: not read.
      if (m[1] !== m[4] || m[2] !== m[5]) continue;
      const month = `${m[1] ?? ""}-${m[2] ?? ""}`;
      const run: Run = { manifest: b.name, lastModified: b.lastModified };
      const held = periods.get(month);
      if (held === undefined || newer(run, held)) periods.set(month, run);
    }
    if (r.next === null) {
      return periods.size === 0
        ? { kind: "gap", reason: AZURE_COST_GAPS.empty }
        : { kind: "listing", periods };
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
 * One billing month's lines, re-sourced to `azure_billing`, or why they cannot be written: an account gap
 * (Parquet) or a `month_gap` (anything unreadable, partial, empty or refused: a stored month is never cleared).
 */
export async function readAzureExportMonth(
  client: AzureBlobClient,
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
