import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import type { SyncResult } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  EMPTY_NIMBUS_VAULT,
  expectServiceItemCount,
  silentSyncContextExtras,
  syncTestContext,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import {
  createPagerdutySyncable,
  MAX_USER_LOOKUPS_PER_SYNC,
  syncPagerdutyIncidentItems,
} from "./pagerduty-sync.ts";

type IncidentMetadata = {
  status: string | null;
  incidentId: string;
  opened_at_ms?: number;
  pagerduty_service_id?: string;
  severity?: string;
  urgency?: string;
  assignee_emails?: string[];
  resolved_by_email?: string | null;
  unattributed_actors?: number;
  meta_v?: number;
};

function readIncidentMetadata(db: Database, externalId: string): IncidentMetadata {
  const row = db
    .prepare("SELECT metadata FROM item WHERE service = ? AND external_id = ?")
    .get("pagerduty", externalId) as { metadata: string };
  return JSON.parse(row.metadata) as IncidentMetadata;
}

// Cursor assertions need fixtures INSIDE the 30-day backfill window: a fresh
// sync floors maxUpdated at now - initialSyncDepthDays, so a hardcoded
// updated_at silently loses the lexicographic max once it ages past the floor.
function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
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

/**
 * Serves the incident list once, then answers /users/{id} lookups from `users`.
 * An id absent from `users` gets the given status, so a 403/404 can be aimed at
 * exactly one actor.
 */
function stubPagerdutyWithUsers(
  incidents: unknown[],
  users: Record<string, { email?: string; status?: number }>,
): { userCalls: string[] } {
  const userCalls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = urlFromFetchInput(input);
    if (url.startsWith("https://api.pagerduty.com/incidents")) {
      return new Response(JSON.stringify({ incidents, more: false }), { status: 200 });
    }
    if (url.startsWith("https://api.pagerduty.com/users/")) {
      userCalls.push(url);
      const id = url.slice("https://api.pagerduty.com/users/".length);
      const u = users[id];
      if (u?.status !== undefined) return new Response("{}", { status: u.status });
      return new Response(JSON.stringify({ user: { id, email: u?.email } }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { userCalls };
}

function resolvedIncident(id: string, resolverId: string): unknown {
  return {
    id,
    title: `Incident ${id}`,
    status: "resolved",
    updated_at: isoHoursAgo(1),
    created_at: isoHoursAgo(2),
    last_status_change_by: { id: resolverId, type: "user_reference" },
  };
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
    const updatedA = isoHoursAgo(26);
    const updatedB = isoHoursAgo(24);
    const { result } = await runOneSyncWithResult([
      {
        id: "PT_A",
        title: "First",
        created_at: isoHoursAgo(27),
        updated_at: updatedA,
        status: "triggered",
        priority: { name: "P1" },
        service: { id: "PJK1HJ8" },
      },
      {
        id: "PT_B",
        title: "Second (newer)",
        created_at: isoHoursAgo(25),
        updated_at: updatedB,
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
    expect(JSON.parse(decodedJson)).toEqual({ lastUpdated: updatedB });
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
    const updatedA = isoHoursAgo(26);
    const updatedB = isoHoursAgo(25);
    const updatedC = isoHoursAgo(24);
    const { calls } = stubPagerdutyPages([
      {
        incidents: [
          {
            id: "P_A",
            title: "A",
            created_at: updatedA,
            updated_at: updatedA,
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
            created_at: updatedB,
            updated_at: updatedB,
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
            created_at: updatedC,
            updated_at: updatedC,
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
    expect(calls).toHaveLength(3);
    expect(new URL(calls[0] as string).searchParams.get("sort_by")).toBe("updated_at:asc"); // NOSONAR S4325: calls[N] is string|undefined under noUncheckedIndexedAccess
    expect(new URL(calls[1] as string).searchParams.get("offset")).toBe("100"); // NOSONAR S4325: calls[N] is string|undefined under noUncheckedIndexedAccess
    expect(new URL(calls[2] as string).searchParams.get("offset")).toBe("200"); // NOSONAR S4325: calls[N] is string|undefined under noUncheckedIndexedAccess
    expect(result.itemsUpserted).toBe(3);
    expect(result.hasMore).toBe(false);
    const cursor = result.cursor as string;
    const decoded = Buffer.from(cursor.slice("nimbus-pd1:".length), "base64url").toString("utf8");
    expect(JSON.parse(decoded)).toEqual({ lastUpdated: updatedC });
  });

  test("respects maxPagesPerSync cap and emits hasMore=true", async () => {
    const updatedA = isoHoursAgo(26);
    const updatedB = isoHoursAgo(25);
    const updatedC = isoHoursAgo(24);
    const { calls } = stubPagerdutyPages([
      {
        incidents: [
          {
            id: "P_A",
            title: "A",
            created_at: updatedA,
            updated_at: updatedA,
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
            created_at: updatedB,
            updated_at: updatedB,
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
            created_at: updatedC,
            updated_at: updatedC,
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
    expect(calls).toHaveLength(2);
    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(true);
    const cursor = result.cursor as string;
    const decoded = Buffer.from(cursor.slice("nimbus-pd1:".length), "base64url").toString("utf8");
    expect(JSON.parse(decoded)).toEqual({ lastUpdated: updatedB });
  });

  test("partial-failure preserves cursor progress from successful pages", async () => {
    const updatedPage1 = isoHoursAgo(24);
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
                created_at: updatedPage1,
                updated_at: updatedPage1,
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
    expect(JSON.parse(decoded)).toEqual({ lastUpdated: updatedPage1 });
  });

  test("cursor floors at the backfill window start when every item is older than the window", async () => {
    const staleUpdated = isoHoursAgo(45 * 24); // 45 days ago — outside the 30-day window
    const before = Date.now();
    const { result } = await runOneSyncWithResult([
      {
        id: "PT_STALE",
        title: "Older than the backfill window",
        created_at: staleUpdated,
        updated_at: staleUpdated,
        status: "resolved",
        service: { id: "PJK1HJ8" },
      },
    ]);
    const after = Date.now();
    expect(result.itemsUpserted).toBe(1);
    const cursor = result.cursor as string;
    const decoded = Buffer.from(cursor.slice("nimbus-pd1:".length), "base64url").toString("utf8");
    const lastUpdated = (JSON.parse(decoded) as { lastUpdated: string }).lastUpdated;
    const lastUpdatedMs = Date.parse(lastUpdated);
    const BACKFILL_DAYS = 30;
    expect(lastUpdatedMs).toBeGreaterThanOrEqual(before - BACKFILL_DAYS * 86_400_000 - 2000);
    expect(lastUpdatedMs).toBeLessThanOrEqual(after - BACKFILL_DAYS * 86_400_000 + 2000);
  });

  // ── decodeCursor edge branches ───────────────────────────────────────────

  test("valid cursor from prior sync is used as since parameter", async () => {
    // Run a first sync to produce a real cursor
    let capturedUrls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      capturedUrls.push(urlFromFetchInput(input));
      return new Response(JSON.stringify({ incidents: [], more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const vault = createStubVault({ "pagerduty.api_token": "tok" });
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });

    // First sync — null cursor, produces a cursor based on floorIso
    const r1 = await sync.sync(syncTestContext(db, vault), null);
    expect(r1.cursor).not.toBeNull();

    capturedUrls = [];
    // Second sync with the valid cursor returned from first sync
    const r2 = await sync.sync(syncTestContext(db, vault), r1.cursor);
    expect(r2.itemsUpserted).toBe(0);
    expect(capturedUrls).toHaveLength(1);
    // The "since" from the second call should be the cursor's lastUpdated (not the 30d floor)
    const since2 = new URL(capturedUrls[0] as string).searchParams.get("since"); // NOSONAR S4325
    expect(since2).not.toBeNull();
  });

  test("decodeCursor: empty-string cursor is treated as null → uses 30-day floor", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(JSON.stringify({ incidents: [], more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const vault = createStubVault({ "pagerduty.api_token": "tok" });
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const before = Date.now();
    await sync.sync(syncTestContext(db, vault), "");
    const after = Date.now();

    expect(capturedUrl).toBeDefined();
    const sinceMs = Date.parse(new URL(capturedUrl as string).searchParams.get("since") as string); // NOSONAR S4325
    const BACKFILL_DAYS = 30;
    expect(sinceMs).toBeGreaterThanOrEqual(before - BACKFILL_DAYS * 86_400_000 - 2000);
    expect(sinceMs).toBeLessThanOrEqual(after - BACKFILL_DAYS * 86_400_000 + 2000);
  });

  test("decodeCursor: wrong-prefix cursor falls back to 30-day floor", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(JSON.stringify({ incidents: [], more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const vault = createStubVault({ "pagerduty.api_token": "tok" });
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const before = Date.now();
    // A cursor with the wrong prefix is treated as invalid → falls back to floor
    await sync.sync(syncTestContext(db, vault), "nimbus-wrongprefix:AAAA");
    const after = Date.now();

    expect(capturedUrl).toBeDefined();
    const sinceMs = Date.parse(new URL(capturedUrl as string).searchParams.get("since") as string); // NOSONAR S4325
    const BACKFILL_DAYS = 30;
    expect(sinceMs).toBeGreaterThanOrEqual(before - BACKFILL_DAYS * 86_400_000 - 2000);
    expect(sinceMs).toBeLessThanOrEqual(after - BACKFILL_DAYS * 86_400_000 + 2000);
  });

  test("decodeCursor: cursor whose payload is a JSON array falls back to 30-day floor", async () => {
    // encode an array payload with the correct prefix
    const arrayPayload = Buffer.from(JSON.stringify([1, 2, 3]), "utf8").toString("base64url");
    const badCursor = `nimbus-pd1:${arrayPayload}`;

    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(JSON.stringify({ incidents: [], more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const vault = createStubVault({ "pagerduty.api_token": "tok" });
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const before = Date.now();
    await sync.sync(syncTestContext(db, vault), badCursor);
    const after = Date.now();

    expect(capturedUrl).toBeDefined();
    const sinceMs = Date.parse(new URL(capturedUrl as string).searchParams.get("since") as string); // NOSONAR S4325
    const BACKFILL_DAYS = 30;
    expect(sinceMs).toBeGreaterThanOrEqual(before - BACKFILL_DAYS * 86_400_000 - 2000);
    expect(sinceMs).toBeLessThanOrEqual(after - BACKFILL_DAYS * 86_400_000 + 2000);
  });

  test("decodeCursor: cursor whose payload is null falls back to 30-day floor", async () => {
    const nullPayload = Buffer.from(JSON.stringify(null), "utf8").toString("base64url");
    const badCursor = `nimbus-pd1:${nullPayload}`;

    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(JSON.stringify({ incidents: [], more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const vault = createStubVault({ "pagerduty.api_token": "tok" });
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const before = Date.now();
    await sync.sync(syncTestContext(db, vault), badCursor);
    const after = Date.now();

    expect(capturedUrl).toBeDefined();
    const sinceMs = Date.parse(new URL(capturedUrl as string).searchParams.get("since") as string); // NOSONAR S4325
    const BACKFILL_DAYS = 30;
    expect(sinceMs).toBeGreaterThanOrEqual(before - BACKFILL_DAYS * 86_400_000 - 2000);
    expect(sinceMs).toBeLessThanOrEqual(after - BACKFILL_DAYS * 86_400_000 + 2000);
  });

  test("decodeCursor: cursor whose payload has numeric lastUpdated falls back to 30-day floor", async () => {
    const numericLu = Buffer.from(JSON.stringify({ lastUpdated: 12345 }), "utf8").toString(
      "base64url",
    );
    const badCursor = `nimbus-pd1:${numericLu}`;

    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(JSON.stringify({ incidents: [], more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const vault = createStubVault({ "pagerduty.api_token": "tok" });
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const before = Date.now();
    await sync.sync(syncTestContext(db, vault), badCursor);
    const after = Date.now();

    expect(capturedUrl).toBeDefined();
    const sinceMs = Date.parse(new URL(capturedUrl as string).searchParams.get("since") as string); // NOSONAR S4325
    const BACKFILL_DAYS = 30;
    expect(sinceMs).toBeGreaterThanOrEqual(before - BACKFILL_DAYS * 86_400_000 - 2000);
    expect(sinceMs).toBeLessThanOrEqual(after - BACKFILL_DAYS * 86_400_000 + 2000);
  });

  test("decodeCursor: cursor whose payload has empty-string lastUpdated falls back to 30-day floor", async () => {
    const emptyLu = Buffer.from(JSON.stringify({ lastUpdated: "" }), "utf8").toString("base64url");
    const badCursor = `nimbus-pd1:${emptyLu}`;

    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(JSON.stringify({ incidents: [], more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const vault = createStubVault({ "pagerduty.api_token": "tok" });
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const before = Date.now();
    await sync.sync(syncTestContext(db, vault), badCursor);
    const after = Date.now();

    expect(capturedUrl).toBeDefined();
    const sinceMs = Date.parse(new URL(capturedUrl as string).searchParams.get("since") as string); // NOSONAR S4325
    const BACKFILL_DAYS = 30;
    expect(sinceMs).toBeGreaterThanOrEqual(before - BACKFILL_DAYS * 86_400_000 - 2000);
    expect(sinceMs).toBeLessThanOrEqual(after - BACKFILL_DAYS * 86_400_000 + 2000);
  });

  // ── parsePagerdutyListResponse edge branches ─────────────────────────────

  test("malformed JSON response causes early return with partial cursor progress", async () => {
    const updatedPage1 = isoHoursAgo(24);
    let call = 0;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            incidents: [
              {
                id: "P_VALID",
                title: "Valid row",
                created_at: updatedPage1,
                updated_at: updatedPage1,
                status: "triggered",
              },
            ],
            more: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Second page returns invalid JSON
      return new Response("not-json-{{{{", { status: 200 });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const vault = createStubVault({ "pagerduty.api_token": "tok" });
    const result = await sync.sync(syncTestContext(db, vault), null);
    expect(result.itemsUpserted).toBe(1);
    expect(result.hasMore).toBe(false);
    const cursor = result.cursor as string;
    const decoded = Buffer.from(cursor.slice("nimbus-pd1:".length), "base64url").toString("utf8");
    expect(JSON.parse(decoded)).toEqual({ lastUpdated: updatedPage1 });
  });

  test("response with incidents field missing returns null → early return", async () => {
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) => {
      // Object without "incidents" key
      return new Response(JSON.stringify({ total: 0, more: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const vault = createStubVault({ "pagerduty.api_token": "tok" });
    const result = await sync.sync(syncTestContext(db, vault), null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  test("response that is a JSON array (not object) returns null → early return", async () => {
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) => {
      return new Response(JSON.stringify([{ id: "x" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const vault = createStubVault({ "pagerduty.api_token": "tok" });
    const result = await sync.sync(syncTestContext(db, vault), null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  // ── syncPagerdutyIncidentItems edge branches (via exported function) ─────

  test("syncPagerdutyIncidentItems: skips non-object items in incidents array", () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "pagerduty.api_token": "tok" }));
    const since = isoHoursAgo(24);
    const { upserted } = syncPagerdutyIncidentItems(
      ctx,
      [null, "string-item", 42, true, undefined],
      since,
      Date.now(),
      new Map(),
    );
    expect(upserted).toBe(0);
    expectServiceItemCount(db, "pagerduty", 0);
  });

  test("syncPagerdutyIncidentItems: skips items with missing or empty-string id", () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "pagerduty.api_token": "tok" }));
    const since = isoHoursAgo(24);
    const { upserted } = syncPagerdutyIncidentItems(
      ctx,
      [
        { title: "No id field" },
        { id: "", title: "Empty id" },
        { id: "VALID_ID", title: "Has id", status: "triggered", created_at: isoHoursAgo(12) },
      ],
      since,
      Date.now(),
      new Map(),
    );
    // Only the item with VALID_ID should be upserted
    expect(upserted).toBe(1);
    expectServiceItemCount(db, "pagerduty", 1);
  });

  test("syncPagerdutyIncidentItems: updated_at not advancing maxUpdated when older than since", () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "pagerduty.api_token": "tok" }));
    const recentSince = isoHoursAgo(5);
    const olderThanSince = isoHoursAgo(10);
    const { maxUpdated } = syncPagerdutyIncidentItems(
      ctx,
      [
        {
          id: "PT_OLD",
          title: "Old item",
          status: "resolved",
          created_at: olderThanSince,
          updated_at: olderThanSince,
        },
      ],
      recentSince,
      Date.now(),
      new Map(),
    );
    // maxUpdated must not go backwards (must stay at recentSince)
    expect(maxUpdated).toBe(recentSince);
  });

  // ── upsertPagerdutyIncident edge branches ────────────────────────────────

  test("falls back to 'Incident <id>' when title field is absent", async () => {
    const db = await runOneSync([
      {
        id: "PT_NO_TITLE",
        status: "triggered",
        created_at: isoHoursAgo(12),
        updated_at: isoHoursAgo(12),
      },
    ]);
    const row = db
      .prepare("SELECT title FROM item WHERE service = ? AND external_id = ?")
      .get("pagerduty", "PT_NO_TITLE") as { title: string };
    expect(row.title).toBe("Incident PT_NO_TITLE");
  });

  test("truncates title longer than 512 characters", async () => {
    const longTitle = "A".repeat(600);
    const db = await runOneSync([
      {
        id: "PT_LONG_TITLE",
        title: longTitle,
        status: "triggered",
        created_at: isoHoursAgo(12),
        updated_at: isoHoursAgo(12),
      },
    ]);
    const row = db
      .prepare("SELECT title FROM item WHERE service = ? AND external_id = ?")
      .get("pagerduty", "PT_LONG_TITLE") as { title: string };
    expect(row.title).toHaveLength(512);
    expect(row.title).toBe("A".repeat(512));
  });

  test("url is null when html_url is absent", async () => {
    const db = await runOneSync([
      {
        id: "PT_NO_URL",
        title: "No url",
        status: "triggered",
        created_at: isoHoursAgo(12),
        updated_at: isoHoursAgo(12),
      },
    ]);
    const row = db
      .prepare("SELECT url FROM item WHERE service = ? AND external_id = ?")
      .get("pagerduty", "PT_NO_URL") as { url: string | null };
    expect(row.url).toBeNull();
  });

  test("modifiedAt falls back to now when updated_at is malformed", async () => {
    const before = Date.now();
    const db = await runOneSync([
      {
        id: "PT_BAD_UPDATED",
        title: "Garbled updated_at",
        status: "triggered",
        created_at: isoHoursAgo(12),
        updated_at: "not-a-date",
      },
    ]);
    const after = Date.now();
    const row = db
      .prepare("SELECT modified_at FROM item WHERE service = ? AND external_id = ?")
      .get("pagerduty", "PT_BAD_UPDATED") as { modified_at: number };
    expect(row.modified_at).toBeGreaterThanOrEqual(before);
    expect(row.modified_at).toBeLessThanOrEqual(after);
  });

  test("omits pagerduty_service_id when service.id is empty string", async () => {
    const db = await runOneSync([
      {
        id: "PT_EMPTY_SVC_ID",
        title: "Empty service id",
        status: "triggered",
        created_at: isoHoursAgo(12),
        updated_at: isoHoursAgo(12),
        service: { id: "" },
      },
    ]);
    const meta = readIncidentMetadata(db, "PT_EMPTY_SVC_ID");
    expect(meta.pagerduty_service_id).toBeUndefined();
  });

  test("omits severity when priority.name is empty string", async () => {
    const db = await runOneSync([
      {
        id: "PT_EMPTY_PRI_NAME",
        title: "Empty priority name",
        status: "triggered",
        created_at: isoHoursAgo(12),
        updated_at: isoHoursAgo(12),
        priority: { id: "P1", name: "" },
      },
    ]);
    const meta = readIncidentMetadata(db, "PT_EMPTY_PRI_NAME");
    expect(meta.severity).toBeUndefined();
  });

  // ── maxPagesPerSync clamping ─────────────────────────────────────────────

  test("maxPagesPerSync of 0 is clamped to 1 — fetches exactly one page", async () => {
    const updatedA = isoHoursAgo(12);
    const { calls } = stubPagerdutyPages([
      {
        incidents: [
          {
            id: "P_CLAMP1",
            title: "First page",
            created_at: updatedA,
            updated_at: updatedA,
            status: "triggered",
          },
        ],
        more: true,
      },
      {
        // second page should never be fetched
        incidents: [],
        more: false,
      },
    ]);
    const db = createMemoryIndexDb();
    const sync = createPagerdutySyncable({
      ensurePagerdutyMcpRunning: async () => {},
      maxPagesPerSync: 0,
    });
    const vault = createStubVault({ "pagerduty.api_token": "tok" });
    const result = await sync.sync(syncTestContext(db, vault), null);
    expect(calls).toHaveLength(1);
    expect(result.itemsUpserted).toBe(1);
    // pdHasMore=true and pagesFetched(1) >= clampedMax(1) → hasMore=true
    expect(result.hasMore).toBe(true);
  });

  test("maxPagesPerSync of 200 is clamped to 100 (upper bound)", async () => {
    // Verify the clamped value is 100 by exhausting pages at 100 — we only
    // supply one page that returns more=false so the loop exits early.
    const updatedA = isoHoursAgo(12);
    stubPagerdutyPages([
      {
        incidents: [
          {
            id: "P_UPPER",
            title: "Single page",
            created_at: updatedA,
            updated_at: updatedA,
            status: "triggered",
          },
        ],
        more: false,
      },
    ]);
    const db = createMemoryIndexDb();
    const sync = createPagerdutySyncable({
      ensurePagerdutyMcpRunning: async () => {},
      maxPagesPerSync: 200,
    });
    const vault = createStubVault({ "pagerduty.api_token": "tok" });
    const result = await sync.sync(syncTestContext(db, vault), null);
    expect(result.itemsUpserted).toBe(1);
    // more=false so hasMore is false regardless of the cap
    expect(result.hasMore).toBe(false);
  });

  test("whitespace-only token is treated as missing → noop", async () => {
    const sync = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const ctx = syncTestContext(
      createMemoryIndexDb(),
      createStubVault({ "pagerduty.api_token": "   " }),
    );
    const result = await sync.sync(ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor).toBeNull();
  });

  test("requests expanded actors so assignee emails cost no extra requests", async () => {
    const { calls } = stubPagerdutyPages([{ incidents: [], more: false }]);
    const db = createMemoryIndexDb();
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    await syncable.sync(syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })), null);

    const url = calls[0] ?? "";
    expect(url).toContain("include%5B%5D=assignees");
    expect(url).toContain("include%5B%5D=acknowledgers");
    expect(url).toContain("include%5B%5D=users");
  });

  // ── attribution metadata ──────────────────────────────────────────────

  test("writes assignee, resolver and meta_v into incident metadata", async () => {
    stubPagerdutyIncidents([
      {
        id: "PD-1",
        title: "Checkout 500s",
        status: "resolved",
        updated_at: isoHoursAgo(1),
        created_at: isoHoursAgo(2),
        assignments: [{ assignee: { id: "PUSER1", email: "jane@example.com" } }],
        last_status_change_by: { id: "PUSER1", type: "user_reference" },
      },
    ]);
    const db = createMemoryIndexDb();
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    await syncable.sync(syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })), null);

    const meta = readIncidentMetadata(db, "PD-1");
    expect(meta.assignee_emails).toEqual(["jane@example.com"]);
    expect(meta.resolved_by_email).toBe("jane@example.com");
    expect(meta.unattributed_actors).toBe(0);
    expect(meta.meta_v).toBe(1);
  });

  // `?? null` rather than a conditional key, so "nobody resolved this" is
  // recorded rather than being indistinguishable from "this connector version
  // did not capture resolution" — the same rule Spec A applied to assignedTo.
  test("records an absent resolver as null, not as a missing key", async () => {
    stubPagerdutyIncidents([
      {
        id: "PD-2",
        title: "Still burning",
        status: "triggered",
        updated_at: isoHoursAgo(1),
        created_at: isoHoursAgo(2),
      },
    ]);
    const db = createMemoryIndexDb();
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    await syncable.sync(syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })), null);

    const meta = readIncidentMetadata(db, "PD-2");
    expect(meta.resolved_by_email).toBeNull();
    expect(meta.assignee_emails).toEqual([]);
  });

  test("the item still carries no author", async () => {
    stubPagerdutyIncidents([
      {
        id: "PD-3",
        title: "Paged",
        status: "resolved",
        updated_at: isoHoursAgo(1),
        created_at: isoHoursAgo(2),
        assignments: [{ assignee: { id: "PUSER1", email: "jane@example.com" } }],
      },
    ]);
    const db = createMemoryIndexDb();
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    await syncable.sync(syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })), null);

    const row = db
      .query("SELECT author_id FROM item WHERE service = 'pagerduty' AND external_id = 'PD-3'")
      .get() as { author_id: string | null };
    expect(row.author_id).toBeNull();
  });

  // ── bounded /users/{id} fallback ────────────────────────────────────────

  test("resolves an unexpanded resolver through one /users lookup", async () => {
    const { userCalls } = stubPagerdutyWithUsers([resolvedIncident("PD-1", "PUSER9")], {
      PUSER9: { email: "jane@example.com" },
    });
    const db = createMemoryIndexDb();
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    await syncable.sync(syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })), null);

    expect(userCalls).toHaveLength(1);
    expect(readIncidentMetadata(db, "PD-1").resolved_by_email).toBe("jane@example.com");
  });

  test("looks a repeated actor up only once per run", async () => {
    const { userCalls } = stubPagerdutyWithUsers(
      [resolvedIncident("PD-1", "PUSER9"), resolvedIncident("PD-2", "PUSER9")],
      { PUSER9: { email: "jane@example.com" } },
    );
    const db = createMemoryIndexDb();
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    await syncable.sync(syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })), null);
    expect(userCalls).toHaveLength(1);
  });

  // The failure that matters: a token scoped before this feature 403s on EVERY
  // lookup. Losing the whole incident index over that is far worse than an
  // unattributed incident. Red-prove it — an implementation that lets the
  // rejection propagate still passes a test that only asserts "no edge".
  test("a 403 on one actor leaves the sync succeeding and every incident indexed", async () => {
    stubPagerdutyWithUsers(
      [resolvedIncident("PD-1", "PUSER9"), resolvedIncident("PD-2", "PUSER8")],
      {
        PUSER9: { status: 403 },
        PUSER8: { email: "bob@example.com" },
      },
    );
    const db = createMemoryIndexDb();
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const result: SyncResult = await syncable.sync(
      syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
      null,
    );

    expect(result.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "pagerduty", 2);
    expect(readIncidentMetadata(db, "PD-1").resolved_by_email).toBeNull();
    expect(readIncidentMetadata(db, "PD-1").unattributed_actors).toBe(1);
    expect(readIncidentMetadata(db, "PD-2").resolved_by_email).toBe("bob@example.com");
  });

  // A 200 with a body that is empty, non-JSON, or missing `user` must degrade to
  // an unattributed incident, never throw. `JSON.parse` sits INSIDE the try for
  // exactly this reason, and `asRecord` returns undefined for null, a primitive,
  // or an array — so no level of the traversal can explode.
  test.each([
    ["an empty body", ""],
    ["non-JSON", "<html>502</html>"],
    ["JSON with no user block", '{"meta":{}}'],
    ["a JSON array", "[]"],
    ["a JSON null", "null"],
    ["a user with no email", '{"user":{"id":"PUSER9"}}'],
  ])("survives a 200 carrying %s", async (_label, body) => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.startsWith("https://api.pagerduty.com/incidents")) {
        return new Response(
          JSON.stringify({ incidents: [resolvedIncident("PD-1", "PUSER9")], more: false }),
          { status: 200 },
        );
      }
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const db = createMemoryIndexDb();
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const result: SyncResult = await syncable.sync(
      syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
      null,
    );

    expect(result.itemsUpserted).toBe(1);
    expect(readIncidentMetadata(db, "PD-1").resolved_by_email).toBeNull();
    expect(readIncidentMetadata(db, "PD-1").unattributed_actors).toBe(1);
  });

  // MAX_USER_LOOKUPS_PER_SYNC + 1 (the list request) acquires exceed the real
  // pagerduty bucket's burst (10 @ 60/min), so the real limiter would sleep for
  // real wall-clock seconds between acquires — same fast-limiter override
  // `zoom-sync.test.ts:294` uses to keep a many-request cap test fast. Rate
  // limiting itself is still exercised: `ctx.rateLimiter.acquire` is still
  // called once per lookup, just against generous quota instead of the real one.
  test("stops at the lookup cap and counts the rest", async () => {
    const incidents = Array.from({ length: MAX_USER_LOOKUPS_PER_SYNC + 5 }, (_, i) =>
      resolvedIncident(`PD-${String(i)}`, `PUSER${String(i)}`),
    );
    const { userCalls } = stubPagerdutyWithUsers(incidents, {});
    const db = createMemoryIndexDb();
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const fastLimiter = new ProviderRateLimiter({
      pagerduty: { requestsPerMinute: 6000, burstSize: 100 },
    });
    const ctx = {
      db,
      vault: createStubVault({ "pagerduty.api_token": "t" }),
      ...silentSyncContextExtras(),
      rateLimiter: fastLimiter,
    };
    await syncable.sync(ctx, null);
    expect(userCalls).toHaveLength(MAX_USER_LOOKUPS_PER_SYNC);
    expectServiceItemCount(db, "pagerduty", MAX_USER_LOOKUPS_PER_SYNC + 5);
  });

  // ── historyFloorMs opt-in ────────────────────────────────────────────────

  test("a cold start honours historyFloorMs", async () => {
    const { calls } = stubPagerdutyPages([{ incidents: [], more: false }]);
    const db = createMemoryIndexDb();
    const floorMs = Date.now() - 200 * 86_400_000;
    const ctx = {
      ...syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
      historyFloorMs: floorMs,
    };
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    await syncable.sync(ctx, null);

    const since = new URL(calls[0] ?? "").searchParams.get("since") ?? "";
    expect(Date.parse(since)).toBeCloseTo(floorMs, -4);
  });

  test("an established cursor beats historyFloorMs", async () => {
    const cursorIso = isoHoursAgo(2);
    const { calls } = stubPagerdutyPages([{ incidents: [], more: false }]);
    const db = createMemoryIndexDb();
    const ctx = {
      ...syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
      historyFloorMs: Date.now() - 200 * 86_400_000,
    };
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const cursor = encodeNimbusJsonCursor("nimbus-pd1:", { lastUpdated: cursorIso });
    await syncable.sync(ctx, cursor);

    expect(new URL(calls[0] ?? "").searchParams.get("since")).toBe(cursorIso);
  });
});
