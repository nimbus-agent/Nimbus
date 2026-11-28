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
import { AZURE_FAKE_PATH, AzureFakeStorage } from "../testing/azure-blob-fake.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { AzureFetch } from "./_lib/azure-token.ts";
import { createAzureBillingCostSyncable } from "./azure-billing-cost-sync.ts";
import {
  AZURE_BLOB_API_VERSION,
  AZURE_BLOB_MAX_BYTES,
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
const PATH = AZURE_FAKE_PATH;
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
const cfg = (over: Partial<NimbusCostAzureConfig> = {}): NimbusCostAzureConfig => ({
  export: { account: "acmecost", container: "exports", path: PATH },
  scopes: [],
  ...over,
});

async function run(
  s: AzureFakeStorage,
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
    const s = new AzureFakeStorage();
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
      s.requests.every((r) => r.auth === "Bearer T1" && r.version === AZURE_BLOB_API_VERSION),
    ).toBe(true);
    const first = new URL(s.requests[0]?.url ?? "");
    expect(first.searchParams.get("prefix")).toBe("focus/monthly/");
    expect(first.searchParams.get("restype")).toBe("container");
  });

  test("of two runs the newest with a manifest is read; a newer run with no manifest yet is ignored", async () => {
    const s = new AzureFakeStorage();
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
    const s = new AzureFakeStorage();
    s.deliver(
      "2026-11",
      [gz(csv(row("A", 10, 1), row("A", 20, 2), row("B", 5, 2)))],
      "Wed, 18 Nov 2026 00:00:00 GMT",
    );
    await run(s, cfg());
    const next = new AzureFakeStorage();
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
    const good = new AzureFakeStorage();
    good.deliver("2026-11", [gz(csv(row("A", 10, 1)))], "Wed, 18 Nov 2026 00:00:00 GMT");
    await run(good, cfg());
    const bad = new AzureFakeStorage();
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
    const good = new AzureFakeStorage();
    good.deliver("2026-11", [gz(csv(row("A", 10, 1)))], "Wed, 18 Nov 2026 00:00:00 GMT");
    await run(good, cfg());
    const rows = new AzureFakeStorage();
    rows.deliver(
      "2026-11",
      [gz(csv("A,nan,USD,2026-11-02T00:00:00Z,S,2026-11-01T00:00:00Z"))],
      "Thu, 19 Nov 2026 00:00:00 GMT",
    );
    expect(Object.values((await run(rows, cfg())).cursor.gaps)[0]).toContain("1 rows");
    const empty = new AzureFakeStorage();
    empty.deliver("2026-11", [gz(""), gz(csv())], "Thu, 19 Nov 2026 00:00:00 GMT");
    expect(Object.values((await run(empty, cfg())).cursor.gaps)[0]).toContain("no rows");
    const outside = new AzureFakeStorage();
    outside.put(
      `${PATH}/20261101-20261130/r/manifest.json`,
      JSON.stringify({ blobs: [{ blobName: "other/x.csv" }] }),
      "Thu, 19 Nov 2026 00:00:00 GMT",
    );
    expect(Object.values((await run(outside, cfg())).cursor.gaps)[0]).toContain("outside");
    const noFiles = new AzureFakeStorage();
    noFiles.put(`${PATH}/20261101-20261130/r/manifest.json`, "{}", "Thu, 19 Nov 2026 00:00:00 GMT");
    expect(Object.values((await run(noFiles, cfg())).cursor.gaps)[0]).toContain("no data files");
    expect(total("A")).toBe(10);
  });

  test("a Parquet export is a stated gap", async () => {
    const s = new AzureFakeStorage();
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
    const s = new AzureFakeStorage();
    s.pageSize = 2;
    s.deliver(
      "2026-11",
      [gz(csv(row("A", 3, 1))), gz(csv(row("A", 4, 2)))],
      "Thu, 19 Nov 2026 00:00:00 GMT",
    );
    await run(s, cfg());
    expect(total("A")).toBe(7);
    expect(s.requests.filter((r) => r.url.includes("comp=list")).length).toBeGreaterThan(1);
    const loop = new AzureFakeStorage();
    loop.pageSize = 1;
    loop.badMarker = true;
    loop.deliver("2026-11", [gz(csv(row("A", 3, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT");
    expect(Object.values((await run(loop, cfg())).cursor.gaps)[0]).toBe(AZURE_COST_GAPS.list);
  });

  test("a range crossing months is the only folder: both months say so; an empty container is a stated gap", async () => {
    const s = new AzureFakeStorage();
    s.put(`${PATH}/20261101-20261201/r/manifest.json`, "{}");
    expect(Object.values((await run(s, cfg())).cursor.gaps)).toEqual([
      AZURE_COST_GAPS.spans("20261101-20261201"),
    ]);
    expect(Object.values((await run(new AzureFakeStorage(), cfg())).cursor.gaps)).toEqual([
      AZURE_COST_GAPS.empty,
    ]);
  });

  test("a folder spanning two months is named as a gap for the months it would cover, not skipped silently", async () => {
    const s = new AzureFakeStorage();
    s.put(`${PATH}/20261101-20261201/r/manifest.json`, "{}");
    s.deliver(
      "2026-10",
      [gz(csv(row("A", 3, 1).replace(/2026-11-01/g, "2026-10-01")))],
      "Thu, 19 Nov 2026 00:00:00 GMT",
    );
    const { cursor } = await run(s, cfg());
    expect(cursor.gaps[WHERE]).toBe(AZURE_COST_GAPS.spans("20261101-20261201"));
    expect(cursor.gaps[WHERE]).toContain("spans two months; use a monthly (month-to-date) export");
    expect(cursor.pending[WHERE]).toEqual(["2026-11"]);
  });

  test("a thrown fetch on the first list request is the not-found gap naming the account; later pages retry", async () => {
    const s = new AzureFakeStorage();
    s.listThrows = true;
    const { cursor } = await run(s, cfg());
    expect(cursor.gaps[WHERE]).toBe(AZURE_COST_GAPS.notFound("acmecost", "exports"));
    expect(cursor.gaps[WHERE]).toContain("acmecost");
    const later = await listAzureExport(
      {
        list: async (_p: string, m: string | null) =>
          m === null
            ? { kind: "page" as const, blobs: [], next: "2" }
            : ({ kind: "retry" } as const),
        download: async () => ({ ok: false as const, transient: false }),
      },
      PATH,
    );
    expect(later.kind).toBe("retry");
  });

  test("other 4xx on list or download are gaps, not retries; 5xx and 429 on download are retries", async () => {
    for (const status of [400, 405, 409]) {
      const s = new AzureFakeStorage();
      s.deliver("2026-11", [gz(csv(row("A", 3, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT");
      s.listStatus = status;
      expect((await run(s, cfg())).cursor.gaps[WHERE]).toBe(AZURE_COST_GAPS.list);
      s.listStatus = 200;
      s.downloadStatus.set(`${PATH}/20261101-20261130/run-1/part_1.csv.gz`, status);
      const r = await run(s, cfg());
      expect(r.cursor.gaps[WHERE]).toContain("could not be read");
      expect(stored()).toHaveLength(0);
    }
    for (const status of [429, 500, 503]) {
      const s = new AzureFakeStorage();
      s.deliver("2026-11", [gz(csv(row("A", 3, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT");
      s.downloadStatus.set(`${PATH}/20261101-20261130/run-1/part_1.csv.gz`, status);
      const r = await run(s, cfg());
      expect(r.cursor.gaps).toEqual({});
      expect(r.cursor.pending[WHERE]).toContain("2026-11");
    }
  });

  test("the size cap holds on a chunked body with no Content-Length: the stream is cancelled past the cap", async () => {
    const s = new AzureFakeStorage();
    s.deliver("2026-11", [gz(csv(row("A", 3, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT");
    s.chunked.add(`${PATH}/20261101-20261130/run-1/part_1.csv.gz`);
    s.chunkBytes = AZURE_BLOB_MAX_BYTES + 4096;
    const { cursor } = await run(s, cfg());
    expect(cursor.gaps[WHERE]).toContain("could not be read");
    expect(stored()).toHaveLength(0);
    // Under the cap the same chunked path returns the bytes (an all-zero body is not a CSV: a parse gap).
    s.chunkBytes = 2048;
    expect((await run(s, cfg())).cursor.gaps[WHERE]).toContain("gzip");
  });

  test("an older complete run is written when the newest run has a missing part", async () => {
    const s = new AzureFakeStorage();
    s.deliver("2026-11", [gz(csv(row("A", 7, 1)))], "Wed, 18 Nov 2026 00:00:00 GMT", "run-1");
    s.deliver(
      "2026-11",
      [gz(csv(row("A", 99, 1))), gz(csv(row("A", 1, 2)))],
      "Thu, 19 Nov 2026 00:00:00 GMT",
      "run-2",
    );
    s.failDownload.add(`${PATH}/20261101-20261130/run-2/part_2.csv.gz`);
    const { cursor } = await run(s, cfg());
    expect(total("A")).toBe(7);
    expect(cursor.gaps).toEqual({});
  });

  test("no complete run is a month_gap with the newest run's reason; a transient failure does not fall back", async () => {
    const s = new AzureFakeStorage();
    s.deliver("2026-11", [gz(csv(row("A", 7, 1)))], "Wed, 18 Nov 2026 00:00:00 GMT", "run-1");
    s.deliver("2026-11", [gz(csv(row("A", 99, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT", "run-2");
    s.failDownload.add(`${PATH}/20261101-20261130/run-1/part_1.csv.gz`);
    s.failDownload.add(`${PATH}/20261101-20261130/run-2/part_1.csv.gz`);
    expect((await run(s, cfg())).cursor.gaps[WHERE]).toContain("could not be read");
    expect(stored()).toHaveLength(0);
    const t = new AzureFakeStorage();
    t.deliver("2026-11", [gz(csv(row("A", 7, 1)))], "Wed, 18 Nov 2026 00:00:00 GMT", "run-1");
    t.deliver("2026-11", [gz(csv(row("A", 99, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT", "run-2");
    t.downloadStatus.set(`${PATH}/20261101-20261130/run-2/part_1.csv.gz`, 503);
    const r = await run(t, cfg());
    expect(stored()).toHaveLength(0); // the older run does not stand in for a retry
    expect(r.cursor.pending[WHERE]).toContain("2026-11");
  });

  test("an expired token (401) is replaced once and the request is sent again", async () => {
    const s = new AzureFakeStorage();
    s.deliver("2026-11", [gz(csv(row("A", 3, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT");
    s.expireOnce = true;
    const { cursor } = await run(s, cfg());
    expect(cursor.gaps).toEqual({});
    expect(total("A")).toBe(3);
    expect(s.tokenCalls).toBe(2);
    const auths = s.requests.map((r) => r.auth);
    expect(auths[0]).toBe("Bearer T1");
    expect(auths[1]).toBe("Bearer T2");
    expect(auths.slice(2).every((a) => a === "Bearer T2")).toBe(true);
  });

  test("a 401 that persists after the new token is the access gap, with one refresh only", async () => {
    const s = new AzureFakeStorage();
    s.deliver("2026-11", [gz(csv(row("A", 3, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT");
    s.listStatus = 401;
    const { cursor } = await run(s, cfg());
    expect(cursor.gaps[WHERE]).toBe(AZURE_COST_GAPS.access);
    expect(s.tokenCalls).toBe(2);
  });

  test("403 names the role; 404 names the container; a 5xx or a refused sign-in is handled; nothing is written", async () => {
    const s = new AzureFakeStorage();
    s.deliver("2026-11", [gz(csv(row("A", 3, 1)))], "Thu, 19 Nov 2026 00:00:00 GMT");
    s.listStatus = 403;
    expect(Object.values((await run(s, cfg())).cursor.gaps)[0]).toContain(
      "Storage Blob Data Reader",
    );
    s.listStatus = 404;
    expect(Object.values((await run(s, cfg())).cursor.gaps)[0]).toBe(
      AZURE_COST_GAPS.notFound("acmecost", "exports"),
    );
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
    const s = new AzureFakeStorage();
    const redirecting: AzureFetch = async (url, init) => {
      if (new URL(url).host === "login.microsoftonline.com") return s.fetch(url, init);
      throw new RedirectRefusedError();
    };
    expect(Object.values((await run(s, cfg(), null, redirecting)).cursor.gaps)[0]).toBe(
      AZURE_COST_GAPS.redirect,
    );
  });

  test("rows dated after today make the month a gap", async () => {
    const s = new AzureFakeStorage();
    s.deliver("2026-11", [gz(csv(row("A", 3, 25)))], "Thu, 19 Nov 2026 00:00:00 GMT");
    expect(Object.values((await run(s, cfg())).cursor.gaps)[0]).toContain("dated after today");
  });

  test("no export and no scopes: the configuration gap; a refused cost config keeps the cursor; no credentials read nothing", async () => {
    const s = new AzureFakeStorage();
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
    const s = new AzureFakeStorage();
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
      download: async () => ({ ok: false as const, transient: false }),
    };
    const r = await listAzureExport(client, PATH);
    expect(r.kind === "gap" && r.reason).toBe(AZURE_COST_GAPS.listCap);
  });
});
