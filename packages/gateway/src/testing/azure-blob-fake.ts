// A fake Azure storage account and token endpoint for the Azure cost sync tests: List Blobs XML with NextMarker
// paging, Get Blob bytes (whole or chunked with no Content-Length), forced statuses, a thrown fetch and an expired
// token. Lives under `testing/` (exempt from the coverage floor); the layout follows Microsoft's export documentation.

import type { AzureFetch } from "../connectors/_lib/azure-token.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";

export const AZURE_FAKE_PATH = "focus/monthly";

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

type Obj = { bytes: Uint8Array; lastModified: string };
export class AzureFakeStorage {
  readonly objects = new Map<string, Obj>();
  readonly requests: { url: string; auth: string | null; version: string | null }[] = [];
  tokenCalls = 0;
  tokenStatus = 200;
  listStatus = 200;
  pageSize = 1000;
  badMarker = false;
  failDownload = new Set<string>();
  downloadStatus = new Map<string, number>();
  /** Keys served as a chunked stream with no Content-Length. */
  chunked = new Set<string>();
  chunkBytes = 0;
  listThrows = false;
  /** The first blob request answers 401 once (an expired token). */
  expireOnce = false;
  put(key: string, bytes: Uint8Array | string, lastModified = "Thu, 19 Nov 2026 10:00:00 GMT") {
    this.objects.set(key, {
      bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
      lastModified,
    });
  }
  /** One run of a month: its parts and the manifest naming them. */
  deliver(
    month: string,
    parts: Uint8Array[],
    lastModified: string,
    run = "run-1",
    ext = "csv.gz",
  ): void {
    const range = `${month.replace("-", "")}01-${month.replace("-", "")}30`;
    const names = parts.map((p, i) => {
      const n = `${AZURE_FAKE_PATH}/${range}/${run}/part_${String(i + 1)}.${ext}`;
      this.put(n, p, lastModified);
      return n;
    });
    this.put(
      `${AZURE_FAKE_PATH}/${range}/${run}/manifest.json`,
      JSON.stringify({ blobs: names.map((blobName) => ({ blobName })) }),
      lastModified,
    );
  }
  fetch: AzureFetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === "login.microsoftonline.com") {
      this.tokenCalls++;
      return this.tokenStatus === 200
        ? new Response(JSON.stringify({ access_token: `T${String(this.tokenCalls)}` }))
        : new Response("no", { status: this.tokenStatus });
    }
    const headers = new Headers(init.headers);
    this.requests.push({
      url,
      auth: headers.get("authorization"),
      version: headers.get("x-ms-version"),
    });
    if (u.host !== "acmecost.blob.core.windows.net") return new Response("x", { status: 404 });
    if (this.listThrows && u.searchParams.get("comp") === "list")
      throw new TypeError("getaddrinfo ENOTFOUND");
    if (this.expireOnce) {
      this.expireOnce = false;
      return new Response("", { status: 401 });
    }
    if (u.searchParams.get("comp") === "list") {
      if (this.listStatus !== 200) return new Response("", { status: this.listStatus });
      const prefix = u.searchParams.get("prefix") ?? "";
      const all = [...this.objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort(codeUnitCompare);
      const marker = u.searchParams.get("marker");
      const start = marker === null ? 0 : Number(marker);
      const page = all.slice(start, start + this.pageSize);
      const more = start + this.pageSize < all.length;
      const next = this.badMarker ? (marker ?? "0") : String(start + this.pageSize);
      const xml = `<?xml version="1.0"?><EnumerationResults><Blobs>${page
        .map(
          (k) =>
            `<Blob><Name>${xmlEscape(k)}</Name><Properties><Last-Modified>${this.objects.get(k)?.lastModified}</Last-Modified></Properties></Blob>`,
        )
        .join(
          "",
        )}</Blobs>${more ? `<NextMarker>${next}</NextMarker>` : "<NextMarker />"}</EnumerationResults>`;
      return new Response(xml);
    }
    const key = decodeURIComponent(u.pathname.replace("/exports/", ""));
    const o = this.objects.get(key);
    const forced = this.downloadStatus.get(key);
    if (forced !== undefined) return new Response("", { status: forced });
    if (o === undefined || this.failDownload.has(key)) return new Response("", { status: 404 });
    if (this.chunked.has(key)) {
      const size = this.chunkBytes;
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (sent >= size) return c.close();
            sent += 1 << 20;
            c.enqueue(new Uint8Array(1 << 20));
          },
        }),
      );
    }
    return new Response(o.bytes);
  };
}
