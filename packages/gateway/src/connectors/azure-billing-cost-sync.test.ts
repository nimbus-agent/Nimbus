// The Azure export sync over the REAL capabilities, store and index; only HTTPS is faked: one fake serves the token
// endpoint and a Blob Storage account (List Blobs XML with NextMarker paging, Get Blob bytes). The layout follows
// Microsoft's export documentation (see azure-billing-export.ts), not a live account.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";

import type { NimbusCostAzureConfig } from "../config/cost-azure-toml.ts";
import { readCostLines } from "../finops/cost-line-store.ts";
import { COST_SYNC_CURSOR_PREFIXES, decodeCostSyncCursor } from "../finops/cost-source-gaps.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { AzureFetch } from "./_lib/azure-token.ts";
import { createAzureBillingCostSyncable } from "./azure-billing-cost-sync.ts";
import {
  AZURE_BLOB_API_VERSION,
  AZURE_COST_GAPS,
  listAzureExport,
  parseBlobList,
} from "./azure-billing-export.ts";
import { RedirectRefusedError } from "./same-origin-fetch.ts";

const NOW = Date.UTC(2026, 10, 20, 9);
const DAY = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.azure_billing;
const HEADER =
  "BillingAccountId,BilledCost,BillingCurrency,ChargePeriodStart,ServiceName,BillingPeriodStart";
const PATH = "focus/monthly";
const WHERE = "azure://acmecost/exports/focus/monthly";

let db: Database;
let vault: NimbusVault;
beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  vault = createMockVault();
  await vault.set("azure.tenant_id", "11111111-2222-3333-4444-555555555555");
  await vault.set("azure.client_id", "app");
  await vault.set("azure.client_secret", "secret");
});
afterEach(() => db.close());

function ctx(): SyncContext {
  upsertSchedulerRegistration(db, "azure_billing", DAY, Date.now(), false);
  return {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "azure_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    depth: "full",
  } as SyncContext;
}

const row = (acct: string, cost: number, day: number, svc = "Storage") =>
  `${acct},${String(cost)},USD,2026-11-${String(day).padStart(2, "0")}T00:00:00Z,${svc},2026-11-01T00:00:00Z`;
const csv = (...rows: string[]) => `${[HEADER, ...rows].join("\n")}\n`;
const gz = (text: string) => Bun.gzipSync(new TextEncoder().encode(text));
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

type Obj = { bytes: Uint8Array; lastModified: string };
class Storage {
  readonly objects = new Map<string, Obj>();
  readonly requests: { url: string; auth: string | null; version: string | null }[] = [];
  tokenCalls = 0;
  tokenStatus = 200;
  listStatus = 200;
  pageSize = 1000;
  badMarker = false;
  failDownload = new Set<string>();
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
      const n = `${PATH}/${range}/${run}/part_${String(i + 1)}.${ext}`;
      this.put(n, p, lastModified);
      return n;
    });
    this.put(
      `${PATH}/${range}/${run}/manifest.json`,
      JSON.stringify({ blobs: names.map((blobName) => ({ blobName })) }),
      lastModified,
    );
  }
  fetch: AzureFetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === "login.microsoftonline.com") {
      this.tokenCalls++;
      return this.tokenStatus === 200
        ? new Response(JSON.stringify({ access_token: "T" }))
        : new Response("no", { status: this.tokenStatus });
    }
    const headers = new Headers(init.headers);
    this.requests.push({
      url,
      auth: headers.get("authorization"),
      version: headers.get("x-ms-version"),
    });
    if (u.host !== "acmecost.blob.core.windows.net") return new Response("x", { status: 404 });
    if (u.searchParams.get("comp") === "list") {
      if (this.listStatus !== 200) return new Response("", { status: this.listStatus });
      const prefix = u.searchParams.get("prefix") ?? "";
      const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
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
    if (o === undefined || this.failDownload.has(key)) return new Response("", { status: 404 });
    return new Response(o.bytes);
  };
}

const cfg = (over: Partial<NimbusCostAzureConfig> = {}): NimbusCostAzureConfig => ({
  export: { account: "acmecost", container: "exports", path: PATH },
  scopes: [],
  ...over,
});

async function run(
  s: Storage,
  config: NimbusCostAzureConfig | null,
  cursor: string | null = null,
  fetchFn: AzureFetch = s.fetch,
) {
  const out = await createAzureBillingCostSyncable({
    azure: () => config,
    now: () => NOW,
    fetch: fetchFn,
  }).sync(ctx(), cursor);
  return { out, cursor: decodeCostSyncCursor(PREFIX, out.cursor) };
}

const stored = () =>
  readCostLines(db, { fromDay: "2026-11-01", toDay: "2026-11-30" }).filter(
    (l) => l.source === "azure_billing",
  );
const total = (acct: string) =>
  stored()
    .filter((l) => l.billingAccountId === acct)
    .reduce((a, l) => a + l.billedCost, 0);

describe("azure_billing: the export path", () => {
  test("a two-part gzipped export becomes lines per billing account, re-sourced to azure_billing", async () => {
    const s = new Storage();
    s.deliver(
      "2026-11",
      [gz(csv(row("A", 10, 1), row("B", 5, 1))), gz(csv(row("A", 2, 2)))],
      "Thu, 19 Nov 2026 10:00:00 GMT",
    );
    const { out, cursor } = await run(s, cfg());
    expect(out.itemsUpserted).toBe(3);
    expect(total("A")).toBe(12);
    expect(total("B")).toBe(5);
    expect(new Set(stored().map((l) => l.provider))).toEqual(new Set(["azure"]));
    expect(cursor.gaps).toEqual({});
    expect(cursor.synced[WHERE]).toBe("2026-11-20");
    expect(s.tokenCalls).toBe(1); // one token for the whole run
    expect(
      s.requests.every((r) => r.auth === "Bearer T" && r.version === AZURE_BLOB_API_VERSION),
    ).toBe(true);
    const first = new URL(s.requests[0]?.url ?? "");
    expect(first.searchParams.get("prefix")).toBe("focus/monthly/");
    expect(first.searchParams.get("restype")).toBe("container");
  });

  test("of two runs the newest with a manifest is read; a newer run with no manifest yet is ignored", async () => {
    const s = new Storage();
    s.deliver("2026-11", [gz(csv(row("A", 1, 1)))], "Wed, 18 Nov 2026 00:00:00 GMT", "run-1");
    s.deliver("2026-11", [gz(csv(row("A", 7, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT", "run-2");
    s.put(
      `${PATH}/20261101-20261130/run-3/part_1.csv.gz`,
      gz(csv(row("A", 99, 1))),
      "Fri, 20 Nov 2026 00:00:00 GMT",
    );
    await run(s, cfg());
    expect(total("A")).toBe(7);
  });

  test("a newer run replaces only the days it covers; other days and other accounts stay", async () => {
    const s = new Storage();
    s.deliver(
      "2026-11",
      [gz(csv(row("A", 10, 1), row("A", 20, 2), row("B", 5, 2)))],
      "Wed, 18 Nov 2026 00:00:00 GMT",
    );
    await run(s, cfg());
    const next = new Storage();
    next.deliver("2026-11", [gz(csv(row("A", 99, 2)))], "Thu, 19 Nov 2026 00:00:00 GMT");
    await run(next, cfg());
    const day = (acct: string, d: string) =>
      stored()
        .filter((l) => l.billingAccountId === acct && l.chargeDay === d)
        .reduce((a, l) => a + l.billedCost, 0);
    expect(day("A", "2026-11-01")).toBe(10);
    expect(day("A", "2026-11-02")).toBe(99);
    expect(day("B", "2026-11-02")).toBe(5);
  });

  test("an unreadable part is a month_gap: nothing is written and the stored month stays", async () => {
    const good = new Storage();
    good.deliver("2026-11", [gz(csv(row("A", 10, 1)))], "Wed, 18 Nov 2026 00:00:00 GMT");
    await run(good, cfg());
    const bad = new Storage();
    bad.deliver(
      "2026-11",
      [gz(csv(row("A", 55, 1))), gz(csv(row("A", 1, 2)))],
      "Thu, 19 Nov 2026 00:00:00 GMT",
    );
    bad.failDownload.add(`${PATH}/20261101-20261130/run-1/part_2.csv.gz`);
    const { cursor } = await run(bad, cfg());
    expect(total("A")).toBe(10);
    expect(cursor.gaps[WHERE]).toContain("could not be read");
    expect(cursor.pending[WHERE]).toEqual(["2026-11"]);
  });

  test("unreadable rows, empty files and a refused manifest never clear a month", async () => {
    const good = new Storage();
    good.deliver("2026-11", [gz(csv(row("A", 10, 1)))], "Wed, 18 Nov 2026 00:00:00 GMT");
    await run(good, cfg());
    const rows = new Storage();
    rows.deliver(
      "2026-11",
      [gz(csv("A,nan,USD,2026-11-02T00:00:00Z,S,2026-11-01T00:00:00Z"))],
      "Thu, 19 Nov 2026 00:00:00 GMT",
    );
    expect(Object.values((await run(rows, cfg())).cursor.gaps)[0]).toContain("1 rows");
    const empty = new Storage();
    empty.deliver("2026-11", [gz(""), gz(csv())], "Thu, 19 Nov 2026 00:00:00 GMT");
    expect(Object.values((await run(empty, cfg())).cursor.gaps)[0]).toContain("no rows");
    const outside = new Storage();
    outside.put(
      `${PATH}/20261101-20261130/r/manifest.json`,
      JSON.stringify({ blobs: [{ blobName: "other/x.csv" }] }),
      "Thu, 19 Nov 2026 00:00:00 GMT",
    );
    expect(Object.values((await run(outside, cfg())).cursor.gaps)[0]).toContain("outside");
    const noFiles = new Storage();
    noFiles.put(`${PATH}/20261101-20261130/r/manifest.json`, "{}", "Thu, 19 Nov 2026 00:00:00 GMT");
    expect(Object.values((await run(noFiles, cfg())).cursor.gaps)[0]).toContain("no data files");
    expect(total("A")).toBe(10);
  });

  test("a Parquet export is a stated gap", async () => {
    const s = new Storage();
    s.deliver(
      "2026-11",
      [new Uint8Array([1])],
      "Thu, 19 Nov 2026 00:00:00 GMT",
      "r",
      "snappy.parquet",
    );
    const { cursor } = await run(s, cfg());
    expect(Object.values(cursor.gaps)).toEqual([AZURE_COST_GAPS.parquet]);
  });

  test("a listing is paged by NextMarker; a marker that does not advance is a gap", async () => {
    const s = new Storage();
    s.pageSize = 2;
    s.deliver(
      "2026-11",
      [gz(csv(row("A", 3, 1))), gz(csv(row("A", 4, 2)))],
      "Thu, 19 Nov 2026 00:00:00 GMT",
    );
    await run(s, cfg());
    expect(total("A")).toBe(7);
    expect(s.requests.filter((r) => r.url.includes("comp=list")).length).toBeGreaterThan(1);
    const loop = new Storage();
    loop.pageSize = 1;
    loop.badMarker = true;
    loop.deliver("2026-11", [gz(csv(row("A", 3, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT");
    expect(Object.values((await run(loop, cfg())).cursor.gaps)[0]).toBe(AZURE_COST_GAPS.list);
  });

  test("a range crossing months is not read; an empty container is a stated gap", async () => {
    const s = new Storage();
    s.put(`${PATH}/20261101-20261201/r/manifest.json`, "{}");
    expect(Object.values((await run(s, cfg())).cursor.gaps)).toEqual([AZURE_COST_GAPS.empty]);
  });

  test("403 names the role; 404 names the container; a 5xx or a refused sign-in is handled; nothing is written", async () => {
    const s = new Storage();
    s.deliver("2026-11", [gz(csv(row("A", 3, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT");
    s.listStatus = 403;
    expect(Object.values((await run(s, cfg())).cursor.gaps)[0]).toContain(
      "Storage Blob Data Reader",
    );
    s.listStatus = 404;
    expect(Object.values((await run(s, cfg())).cursor.gaps)[0]).toBe(AZURE_COST_GAPS.notFound);
    s.listStatus = 503;
    const r = await run(s, cfg());
    expect(r.cursor.gaps).toEqual({});
    expect(r.cursor.pending[WHERE]?.length).toBeGreaterThan(0);
    s.listStatus = 200;
    s.tokenStatus = 401;
    expect(Object.values((await run(s, cfg())).cursor.gaps)[0]).toContain(
      "refused the stored service principal",
    );
    expect(stored()).toHaveLength(0);
  });

  test("a redirect off the storage host is a stated gap", async () => {
    const s = new Storage();
    const redirecting: AzureFetch = async (url, init) => {
      if (new URL(url).host === "login.microsoftonline.com") return s.fetch(url, init);
      throw new RedirectRefusedError();
    };
    expect(Object.values((await run(s, cfg(), null, redirecting)).cursor.gaps)[0]).toBe(
      AZURE_COST_GAPS.redirect,
    );
  });

  test("rows dated after today make the month a gap", async () => {
    const s = new Storage();
    s.deliver("2026-11", [gz(csv(row("A", 3, 25)))], "Thu, 19 Nov 2026 00:00:00 GMT");
    expect(Object.values((await run(s, cfg())).cursor.gaps)[0]).toContain("dated after today");
  });

  test("no export and no scopes: the configuration gap; a refused cost config keeps the cursor; no credentials read nothing", async () => {
    const s = new Storage();
    expect(Object.values((await run(s, cfg({ export: null }))).cursor.gaps)).toEqual([
      AZURE_COST_GAPS.notConfigured,
    ]);
    const kept = await run(s, null, "nimbus-azb1:abc");
    expect(kept.out.cursor).toBe("nimbus-azb1:abc");
    expect((await run(s, null)).out.cursor).toContain(PREFIX);
    await vault.delete("azure.client_secret");
    s.deliver("2026-11", [gz(csv(row("A", 3, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT");
    await run(s, cfg());
    expect(s.tokenCalls).toBe(0);
    expect(stored()).toHaveLength(0);
  });

  test("a month the export has no folder for is not a gap", async () => {
    const s = new Storage();
    s.deliver(
      "2026-10",
      [
        gz(
          csv(
            row("A", 3, 1).replace("2026-11-01", "2026-10-01").replace("2026-11-01", "2026-10-01"),
          ),
        ),
      ],
      "Thu, 19 Nov 2026 00:00:00 GMT",
    );
    const { cursor } = await run(s, cfg());
    expect(cursor.gaps).toEqual({});
  });
});

describe("parseBlobList and listAzureExport", () => {
  test("parse: names are XML-unescaped, an empty NextMarker is none, a non-enumeration is null", () => {
    expect(parseBlobList("<html/>")).toBeNull();
    const p = parseBlobList(
      '<EnumerationResults><Blobs><Blob><Name>a&amp;b/c</Name><Properties><Last-Modified>Thu, 19 Nov 2026 10:00:00 GMT</Last-Modified></Properties></Blob><Blob><Name encoded="true">x</Name></Blob></Blobs><NextMarker>m1</NextMarker></EnumerationResults>',
    );
    expect(p?.blobs.map((b) => b.name)).toEqual(["a&b/c"]);
    expect(p?.blobs[0]?.lastModified).toBe(Date.UTC(2026, 10, 19, 10));
    expect(p?.next).toBe("m1");
  });

  test("a listing that never ends hits the page cap", async () => {
    const client = {
      list: async (_p: string, m: string | null) => ({
        kind: "page" as const,
        blobs: [],
        next: `${m ?? ""}x`,
      }),
      download: async () => ({ ok: false as const }),
    };
    const r = await listAzureExport(client, PATH);
    expect(r.kind === "gap" && r.reason).toBe(AZURE_COST_GAPS.listCap);
  });
});
