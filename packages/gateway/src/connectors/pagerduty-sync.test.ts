import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { SyncResult } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  EMPTY_NIMBUS_VAULT,
  silentSyncContextExtras,
  syncTestContext,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { createPagerdutySyncable } from "./pagerduty-sync.ts";

type IncidentMetadata = {
  status: string | null;
  incidentId: string;
  opened_at_ms?: number;
  pagerduty_service_id?: string;
  severity?: string;
  urgency?: string;
};

function readIncidentMetadata(db: Database, externalId: string): IncidentMetadata {
  const row = db
    .prepare("SELECT metadata FROM item WHERE service = ? AND external_id = ?")
    .get("pagerduty", externalId) as { metadata: string };
  return JSON.parse(row.metadata) as IncidentMetadata;
}

function stubPagerdutyIncidents(incidents: unknown[]): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = urlFromFetchInput(input);
    if (!url.startsWith("https://api.pagerduty.com/incidents")) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return new Response(JSON.stringify({ incidents }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

type PdPageResponse = { incidents: unknown[]; more: boolean };

function stubPagerdutyPages(pages: readonly PdPageResponse[]): { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = urlFromFetchInput(input);
    calls.push(url);
    if (!url.startsWith("https://api.pagerduty.com/incidents")) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const page = pages[i];
    i += 1;
    if (page === undefined) {
      throw new Error(`stubPagerdutyPages: call ${i} exceeds ${pages.length} configured pages`);
    }
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

async function runOneSync(incidents: unknown[]): Promise<Database> {
  stubPagerdutyIncidents(incidents);
  const db = createMemoryIndexDb();
  const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  const vault = createStubVault({ "pagerduty.api_token": "test-token" });
  await sync.sync(syncTestContext(db, vault), null);
  return db;
}

async function runOneSyncWithResult(
  incidents: unknown[],
): Promise<{ db: Database; result: SyncResult }> {
  stubPagerdutyIncidents(incidents);
  const db = createMemoryIndexDb();
  const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  const vault = createStubVault({ "pagerduty.api_token": "test-token" });
  const result = await sync.sync(syncTestContext(db, vault), null);
  return { db, result };
}

describeWithFetchRestore("pagerduty-sync", () => {
  testConnectorSyncNoop(
    "no-op when credentials missing",
    () => createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} }),
    EMPTY_NIMBUS_VAULT,
  );

  test("no-op when token is empty string", async () => {
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({ "pagerduty.api_token": "" }),
      db: createMemoryIndexDb(),
      ...silentSyncContextExtras(),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("enriches with opened_at_ms, pagerduty_service_id, severity on happy path", async () => {
    const db = await runOneSync([
      {
        id: "PT4KHLK",
        title: "High error rate on payment-service",
        created_at: "2026-05-10T18:30:21Z",
        updated_at: "2026-05-10T18:45:00Z",
        status: "triggered",
        html_url: "https://acme.pagerduty.com/incidents/PT4KHLK",
        priority: { id: "P53ZZH5", type: "priority_reference", name: "P1" },
        service: { id: "PJK1HJ8", type: "service_reference", summary: "payment-service" },
      },
    ]);
    const meta = readIncidentMetadata(db, "PT4KHLK");
    expect(meta.opened_at_ms).toBe(Date.parse("2026-05-10T18:30:21Z"));
    expect(meta.pagerduty_service_id).toBe("PJK1HJ8");
    expect(meta.severity).toBe("P1");
    expect(meta.status).toBe("triggered");
    expect(meta.incidentId).toBe("PT4KHLK");
  });

  test("writes urgency when present", async () => {
    const db = await runOneSync([
      {
        id: "PT_URGENT",
        title: "Urgent but no priority",
        created_at: "2026-05-10T18:30:21Z",
        updated_at: "2026-05-10T18:30:21Z",
        status: "triggered",
        urgency: "high",
        service: { id: "PJK1HJ8" },
      },
    ]);
    const meta = readIncidentMetadata(db, "PT_URGENT");
    expect(meta.urgency).toBe("high");
  });

  test("omits urgency when absent or empty", async () => {
    const db = await runOneSync([
      {
        id: "PT_NO_URG",
        title: "No urgency field",
        created_at: "2026-05-10T18:30:21Z",
        updated_at: "2026-05-10T18:30:21Z",
        status: "triggered",
        service: { id: "PJK1HJ8" },
      },
      {
        id: "PT_EMPTY_URG",
        title: "Empty urgency string",
        created_at: "2026-05-10T18:30:21Z",
        updated_at: "2026-05-10T18:30:21Z",
        status: "triggered",
        urgency: "",
        service: { id: "PJK1HJ8" },
      },
    ]);
    expect(readIncidentMetadata(db, "PT_NO_URG").urgency).toBeUndefined();
    expect(readIncidentMetadata(db, "PT_EMPTY_URG").urgency).toBeUndefined();
  });

  test("omits severity when priority is null", async () => {
    const db = await runOneSync([
      {
        id: "PT_NULL_PRI",
        title: "Unprioritised incident",
        created_at: "2026-05-10T18:30:21Z",
        updated_at: "2026-05-10T18:30:21Z",
        status: "triggered",
        priority: null,
        service: { id: "PJK1HJ8" },
      },
    ]);
    const meta = readIncidentMetadata(db, "PT_NULL_PRI");
    expect(meta.severity).toBeUndefined();
    expect(meta.opened_at_ms).toBe(Date.parse("2026-05-10T18:30:21Z"));
    expect(meta.pagerduty_service_id).toBe("PJK1HJ8");
  });

  test("omits severity when priority.name missing", async () => {
    const db = await runOneSync([
      {
        id: "PT_NO_NAME",
        title: "Priority object without name",
        created_at: "2026-05-10T18:30:21Z",
        updated_at: "2026-05-10T18:30:21Z",
        status: "triggered",
        priority: { id: "P53ZZH5" },
        service: { id: "PJK1HJ8" },
      },
    ]);
    const meta = readIncidentMetadata(db, "PT_NO_NAME");
    expect(meta.severity).toBeUndefined();
  });

  test("omits pagerduty_service_id when service object missing", async () => {
    const db = await runOneSync([
      {
        id: "PT_NO_SVC",
        title: "Defensive: no service",
        created_at: "2026-05-10T18:30:21Z",
        updated_at: "2026-05-10T18:30:21Z",
        status: "triggered",
        priority: { name: "P1" },
      },
    ]);
    const meta = readIncidentMetadata(db, "PT_NO_SVC");
    expect(meta.pagerduty_service_id).toBeUndefined();
    expect(meta.opened_at_ms).toBe(Date.parse("2026-05-10T18:30:21Z"));
    expect(meta.severity).toBe("P1");
  });

  test("omits pagerduty_service_id when service.id missing", async () => {
    const db = await runOneSync([
      {
        id: "PT_NO_SVC_ID",
        title: "Service summary only",
        created_at: "2026-05-10T18:30:21Z",
        updated_at: "2026-05-10T18:30:21Z",
        status: "triggered",
        priority: { name: "P1" },
        service: { summary: "payment-service" },
      },
    ]);
    const meta = readIncidentMetadata(db, "PT_NO_SVC_ID");
    expect(meta.pagerduty_service_id).toBeUndefined();
  });

  test("passes severity through verbatim for non-P1 names", async () => {
    const db = await runOneSync([
      {
        id: "PT_P2",
        title: "P2 verbatim",
        created_at: "2026-05-10T18:30:21Z",
        updated_at: "2026-05-10T18:30:21Z",
        status: "acknowledged",
        priority: { id: "PXX", name: "P2" },
        service: { id: "PJK1HJ8" },
      },
    ]);
    const meta = readIncidentMetadata(db, "PT_P2");
    expect(meta.severity).toBe("P2");
  });

  test("omits opened_at_ms when created_at is malformed", async () => {
    const db = await runOneSync([
      {
        id: "PT_BAD_TIME",
        title: "Garbled timestamp",
        created_at: "yesterday",
        updated_at: "2026-05-10T18:30:21Z",
        status: "triggered",
        priority: { name: "P1" },
        service: { id: "PJK1HJ8" },
      },
    ]);
    const meta = readIncidentMetadata(db, "PT_BAD_TIME");
    expect(meta.opened_at_ms).toBeUndefined();
    expect(meta.severity).toBe("P1");
    expect(meta.pagerduty_service_id).toBe("PJK1HJ8");
  });

  test("omits opened_at_ms when created_at absent", async () => {
    const db = await runOneSync([
      {
        id: "PT_NO_CREATED",
        title: "No created_at",
        updated_at: "2026-05-10T18:30:21Z",
        status: "triggered",
        priority: { name: "P1" },
        service: { id: "PJK1HJ8" },
      },
    ]);
    const meta = readIncidentMetadata(db, "PT_NO_CREATED");
    expect(meta.opened_at_ms).toBeUndefined();
  });

  test("cursor advancement still works with new metadata", async () => {
    const { result } = await runOneSyncWithResult([
      {
        id: "PT_A",
        title: "First",
        created_at: "2026-05-10T10:00:00Z",
        updated_at: "2026-05-10T10:01:00Z",
        status: "triggered",
        priority: { name: "P1" },
        service: { id: "PJK1HJ8" },
      },
      {
        id: "PT_B",
        title: "Second (newer)",
        created_at: "2026-05-10T11:00:00Z",
        updated_at: "2026-05-10T11:05:00Z",
        status: "acknowledged",
        priority: { name: "P2" },
        service: { id: "PJK1HJ8" },
      },
    ]);
    expect(result.itemsUpserted).toBe(2);
    expect(result.cursor).not.toBeNull();
    const cursor = result.cursor as string;
    expect(cursor.startsWith("nimbus-pd1:")).toBe(true);
    const decodedJson = Buffer.from(cursor.slice("nimbus-pd1:".length), "base64url").toString(
      "utf8",
    );
    expect(JSON.parse(decodedJson)).toEqual({ lastUpdated: "2026-05-10T11:05:00Z" });
  });

  test("does not throw on entirely malformed row", async () => {
    const db = await runOneSync([{ id: "PT_BARE" }]);
    const meta = readIncidentMetadata(db, "PT_BARE");
    expect(meta.incidentId).toBe("PT_BARE");
    expect(meta.opened_at_ms).toBeUndefined();
    expect(meta.pagerduty_service_id).toBeUndefined();
    expect(meta.severity).toBeUndefined();
  });

  test("fresh install uses 30-day backfill window", async () => {
    const EXPECTED_BACKFILL_DAYS = 30;
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(JSON.stringify({ incidents: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const db = createMemoryIndexDb();
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const vault = createStubVault({ "pagerduty.api_token": "test-token" });
    const before = Date.now();
    await sync.sync(syncTestContext(db, vault), null);
    const after = Date.now();
    expect(capturedUrl).toBeDefined();
    const since = new URL(capturedUrl as string).searchParams.get("since"); // NOSONAR S4325: capturedUrl is string|undefined (narrowed by the toBeDefined above)
    expect(since).toBeDefined();
    const sinceMs = Date.parse(since as string);
    const expectedMin = before - EXPECTED_BACKFILL_DAYS * 86_400_000 - 2000;
    const expectedMax = after - EXPECTED_BACKFILL_DAYS * 86_400_000 + 2000;
    expect(sinceMs).toBeGreaterThanOrEqual(expectedMin);
    expect(sinceMs).toBeLessThanOrEqual(expectedMax);
  });

  test("walks pages until parsed.more=false", async () => {
    const { calls } = stubPagerdutyPages([
      {
        incidents: [
          {
            id: "P_A",
            title: "A",
            created_at: "2026-05-10T10:00:00Z",
            updated_at: "2026-05-10T10:00:00Z",
            status: "triggered",
            priority: { name: "P1" },
            service: { id: "PJK1HJ8" },
          },
        ],
        more: true,
      },
      {
        incidents: [
          {
            id: "P_B",
            title: "B",
            created_at: "2026-05-10T11:00:00Z",
            updated_at: "2026-05-10T11:00:00Z",
            status: "triggered",
            priority: { name: "P1" },
            service: { id: "PJK1HJ8" },
          },
        ],
        more: true,
      },
      {
        incidents: [
          {
            id: "P_C",
            title: "C",
            created_at: "2026-05-10T12:00:00Z",
            updated_at: "2026-05-10T12:00:00Z",
            status: "triggered",
            priority: { name: "P1" },
            service: { id: "PJK1HJ8" },
          },
        ],
        more: false,
      },
    ]);
    const db = createMemoryIndexDb();
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const vault = createStubVault({ "pagerduty.api_token": "test-token" });
    const result = await sync.sync(syncTestContext(db, vault), null);
    expect(calls.length).toBe(3);
    expect(new URL(calls[0] as string).searchParams.get("sort_by")).toBe("updated_at:asc"); // NOSONAR S4325: calls[N] is string|undefined under noUncheckedIndexedAccess
    expect(new URL(calls[1] as string).searchParams.get("offset")).toBe("100"); // NOSONAR S4325: calls[N] is string|undefined under noUncheckedIndexedAccess
    expect(new URL(calls[2] as string).searchParams.get("offset")).toBe("200"); // NOSONAR S4325: calls[N] is string|undefined under noUncheckedIndexedAccess
    expect(result.itemsUpserted).toBe(3);
    expect(result.hasMore).toBe(false);
    const cursor = result.cursor as string;
    const decoded = Buffer.from(cursor.slice("nimbus-pd1:".length), "base64url").toString("utf8");
    expect(JSON.parse(decoded)).toEqual({ lastUpdated: "2026-05-10T12:00:00Z" });
  });

  test("respects maxPagesPerSync cap and emits hasMore=true", async () => {
    const { calls } = stubPagerdutyPages([
      {
        incidents: [
          {
            id: "P_A",
            title: "A",
            created_at: "2026-05-10T10:00:00Z",
            updated_at: "2026-05-10T10:00:00Z",
            status: "triggered",
            priority: { name: "P1" },
            service: { id: "PJK1HJ8" },
          },
        ],
        more: true,
      },
      {
        incidents: [
          {
            id: "P_B",
            title: "B",
            created_at: "2026-05-10T11:00:00Z",
            updated_at: "2026-05-10T11:00:00Z",
            status: "triggered",
            priority: { name: "P1" },
            service: { id: "PJK1HJ8" },
          },
        ],
        more: true,
      },
      {
        incidents: [
          {
            id: "P_C",
            title: "Never reached",
            created_at: "2026-05-10T12:00:00Z",
            updated_at: "2026-05-10T12:00:00Z",
            status: "triggered",
            priority: { name: "P1" },
            service: { id: "PJK1HJ8" },
          },
        ],
        more: true,
      },
    ]);
    const db = createMemoryIndexDb();
    const sync = createPagerdutySyncable({
      ensurePagerdutyMcpRunning: async () => {},
      maxPagesPerSync: 2,
    });
    const vault = createStubVault({ "pagerduty.api_token": "test-token" });
    const result = await sync.sync(syncTestContext(db, vault), null);
    expect(calls.length).toBe(2);
    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(true);
    const cursor = result.cursor as string;
    const decoded = Buffer.from(cursor.slice("nimbus-pd1:".length), "base64url").toString("utf8");
    expect(JSON.parse(decoded)).toEqual({ lastUpdated: "2026-05-10T11:00:00Z" });
  });

  test("partial-failure preserves cursor progress from successful pages", async () => {
    let call = 0;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            incidents: [
              {
                id: "P_PAGE1",
                title: "Page 1 row",
                created_at: "2026-05-10T10:00:00Z",
                updated_at: "2026-05-10T10:00:00Z",
                status: "triggered",
                priority: { name: "P1" },
                service: { id: "PJK1HJ8" },
              },
            ],
            more: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Internal Server Error", { status: 500 });
    }) as typeof fetch;
    const db = createMemoryIndexDb();
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const vault = createStubVault({ "pagerduty.api_token": "test-token" });
    const result = await sync.sync(syncTestContext(db, vault), null);
    expect(result.itemsUpserted).toBe(1);
    expect(result.hasMore).toBe(false);
    const cursor = result.cursor as string;
    const decoded = Buffer.from(cursor.slice("nimbus-pd1:".length), "base64url").toString("utf8");
    expect(JSON.parse(decoded)).toEqual({ lastUpdated: "2026-05-10T10:00:00Z" });
  });
});
