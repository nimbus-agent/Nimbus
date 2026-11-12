import { expect, test } from "bun:test";

import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  syncTestContext,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import {
  JSM_ALERT_MAX_OPEN_IDS,
  JSM_ALERT_MAX_PAGES,
  JSM_ALERT_PAGE_SIZE,
  JSM_ALERT_WINDOW_MS,
  runJsmAlerts,
} from "./jsm-alerts.ts";
import { JSM_STEP_BUDGET_MS, JSM_UNAVAILABLE_BACKOFF_MS } from "./jsm-oncall.ts";

const SITE = "https://acme.atlassian.net";
const CID = "0123abcd-0123-4abc-8abc-0123456789ab";
const ROOT = `https://api.atlassian.com/jsm/ops/api/${CID}/v1`;
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const DAY = 86_400_000;
const CREDS = { token: "tok", email: "u@acme.com", baseUrl: SITE };

type Db = ReturnType<typeof createMemoryIndexDb>;

function ctxFor(db: Db, secrets: Record<string, string> = { "jira.cloud_id": CID }): SyncContext {
  return {
    ...syncTestContext(db, createStubVault({ ...secrets }), "jira"),
    rateLimiter: new ProviderRateLimiter({ jira: { requestsPerMinute: 60_000, burstSize: 1000 } }),
  };
}

function alert(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    message: `Alert ${id}`,
    status: "open",
    priority: "P2",
    acknowledged: false,
    createdAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 3_600_000).toISOString(),
    tags: [],
    ...over,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

type Handler = (url: URL) => Response | undefined;

function stub(handler: Handler): { urls: string[]; alertUrls: string[] } {
  const urls: string[] = [];
  const alertUrls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = urlFromFetchInput(input);
    urls.push(url);
    expect(init?.redirect).toBe("manual");
    if (url.includes("/alerts")) alertUrls.push(url);
    const res = handler(new URL(url));
    return res ?? new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { urls, alertUrls };
}

const query = (u: URL): string | null => u.searchParams.get("query");
const offset = (u: URL): number => Number(u.searchParams.get("offset"));
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

function stored(db: Db): { external_id: string; metadata: string }[] {
  return db
    .query(
      "SELECT external_id, metadata FROM item WHERE service = 'jira' AND type = 'alert' ORDER BY external_id",
    )
    .all() as { external_id: string; metadata: string }[];
}

describeWithFetchRestore("runJsmAlerts", () => {
  test("indexes open and recently closed alerts, records alAt and alOpen, and sends only pinned requests", async () => {
    const db = createMemoryIndexDb();
    try {
      const { alertUrls } = stub((u) => {
        if (!u.pathname.endsWith("/alerts")) return undefined;
        if (query(u) === "status:open") return json({ values: [alert("o1"), alert("o2")] });
        if (query(u) === "status:closed") {
          return json({ values: [alert("c1", { status: "closed", updatedAt: iso(NOW - DAY) })] });
        }
        return undefined;
      });
      const run = await runJsmAlerts(ctxFor(db), CREDS, {}, NOW);
      expect(stored(db).map((r) => r.external_id)).toEqual(["c1", "o1", "o2"]);
      expect(run.upserted).toBe(3);
      expect(run.fields.alAt).toBe(NOW);
      expect(run.fields.alOpen).toEqual(["o1", "o2"]);
      expect(run.fields.alUntil).toBeUndefined();
      // The cloud id came from the Vault and is not a new cursor value.
      expect(run.fields.cid).toBe(CID);
      for (const u of alertUrls) expect(u.startsWith(`${ROOT}/alerts?`)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a request URL never follows links.next and every page request is built by the pass", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub((u) =>
        u.pathname.endsWith("/alerts")
          ? json({ values: [alert("o1")], links: { next: "https://evil.example/steal" } })
          : undefined,
      );
      await runJsmAlerts(ctxFor(db), CREDS, {}, NOW);
      expect(urls.every((u) => u.startsWith("https://api.atlassian.com/jsm/ops/api/"))).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a closed alert older than 7 days is not written and stops the closed pass", async () => {
    const db = createMemoryIndexDb();
    try {
      const full = (n: number, base: number): Record<string, unknown>[] =>
        Array.from({ length: JSM_ALERT_PAGE_SIZE }, (_, i) =>
          alert(`c${String(n)}-${String(i)}`, { status: "closed", updatedAt: iso(base - i) }),
        );
      const { alertUrls } = stub((u) => {
        if (query(u) === "status:open") return json({ values: [] });
        if (query(u) === "status:closed") {
          // Page 1: all inside the window except the LAST entry, which is 8 days old.
          const page = full(1, NOW - DAY);
          page[page.length - 1] = alert("old", {
            status: "closed",
            updatedAt: iso(NOW - 8 * DAY),
          });
          return offset(u) === 0 ? json({ values: page }) : json({ values: full(2, NOW - DAY) });
        }
        return undefined;
      });
      await runJsmAlerts(ctxFor(db), CREDS, {}, NOW);
      expect(stored(db).some((r) => r.external_id === "old")).toBe(false);
      expect(stored(db)).toHaveLength(JSM_ALERT_PAGE_SIZE - 1);
      expect(alertUrls.filter((u) => u.includes("status%3Aclosed"))).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("an open alert older than 7 days is written", async () => {
    const db = createMemoryIndexDb();
    try {
      stub((u) => {
        if (query(u) === "status:open") {
          return json({
            values: [alert("ancient", { updatedAt: iso(NOW - JSM_ALERT_WINDOW_MS - DAY) })],
          });
        }
        return query(u) === "status:closed" ? json({ values: [] }) : undefined;
      });
      await runJsmAlerts(ctxFor(db), CREDS, {}, NOW);
      expect(stored(db).map((r) => r.external_id)).toEqual(["ancient"]);
    } finally {
      db.close();
    }
  });

  test("reads at most five pages per status and marks the open listing incomplete at the cap", async () => {
    const db = createMemoryIndexDb();
    try {
      let n = 0;
      const { alertUrls } = stub((u) => {
        if (query(u) === "status:open") {
          n += 1;
          return json({
            values: Array.from({ length: JSM_ALERT_PAGE_SIZE }, (_, i) =>
              alert(`o${String(n)}-${String(i)}`),
            ),
          });
        }
        return query(u) === "status:closed" ? json({ values: [] }) : undefined;
      });
      const run = await runJsmAlerts(ctxFor(db), CREDS, { alOpen: ["prev-open"] }, NOW);
      expect(alertUrls.filter((u) => u.includes("status%3Aopen"))).toHaveLength(
        JSM_ALERT_MAX_PAGES,
      );
      // Incomplete: no reconciliation, and the previous ids stay in the union (capped).
      expect(alertUrls.some((u) => u.includes("/alerts/prev-open"))).toBe(false);
      expect(run.fields.alOpen).toHaveLength(JSM_ALERT_MAX_OPEN_IDS);
      expect(run.fields.alOpen?.includes("prev-open")).toBe(false);
      const small = await runJsmAlerts(ctxFor(db), CREDS, { alOpen: ["prev-open"] }, NOW);
      expect(small.fields.alOpen?.length).toBeLessThanOrEqual(JSM_ALERT_MAX_OPEN_IDS);
    } finally {
      db.close();
    }
  });

  test("a 400 on the filtered list falls back once to an unfiltered list and logs it", async () => {
    const db = createMemoryIndexDb();
    try {
      const infos: string[] = [];
      const ctx = ctxFor(db);
      const logged: SyncContext = {
        ...ctx,
        logger: { ...ctx.logger, info: ((_: unknown, m?: string) => infos.push(m ?? "")) as never },
      };
      const { alertUrls } = stub((u) => {
        if (query(u) !== null) return new Response("{}", { status: 400 });
        return json({
          values: [
            alert("o1"),
            alert("c-in", { status: "closed", updatedAt: iso(NOW - DAY) }),
            alert("c-out", { status: "closed", updatedAt: iso(NOW - 9 * DAY) }),
          ],
        });
      });
      const run = await runJsmAlerts(logged, CREDS, {}, NOW);
      expect(stored(db).map((r) => r.external_id)).toEqual(["c-in", "o1"]);
      expect(alertUrls.filter((u) => !u.includes("query="))).toHaveLength(1);
      expect(alertUrls.filter((u) => u.includes("query="))).toHaveLength(1);
      expect(run.fields.alOpen).toEqual(["o1"]);
      expect(infos.some((m) => m.includes("falling back"))).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a 400 with a failing fallback ends the pass without a backoff", async () => {
    const db = createMemoryIndexDb();
    try {
      stub((u) =>
        query(u) === null
          ? new Response("{}", { status: 500 })
          : new Response("{}", { status: 400 }),
      );
      const run = await runJsmAlerts(ctxFor(db), CREDS, {}, NOW);
      expect(run.upserted).toBe(0);
      expect(run.fields.alUntil).toBeUndefined();
      expect(run.fields.alAt).toBe(NOW);
    } finally {
      db.close();
    }
  });

  for (const status of [401, 403, 404]) {
    test(`a ${String(status)} on the first list sets alUntil six hours out`, async () => {
      const db = createMemoryIndexDb();
      try {
        stub(() => new Response("{}", { status }));
        const run = await runJsmAlerts(ctxFor(db), CREDS, {}, NOW);
        expect(run.fields.alUntil).toBe(NOW + JSM_UNAVAILABLE_BACKOFF_MS);
        expect(run.fields.alAt).toBe(NOW);
        expect(stored(db)).toEqual([]);
      } finally {
        db.close();
      }
    });
  }

  test("a 5xx or a transport failure is an attempt with no backoff and no throw", async () => {
    const db = createMemoryIndexDb();
    try {
      globalThis.fetch = (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;
      const run = await runJsmAlerts(ctxFor(db), CREDS, {}, NOW);
      expect(run.fields.alAt).toBe(NOW);
      expect(run.fields.alUntil).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("no stored cloud id on a non-atlassian.net site makes no request and no throw", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub(() => json({}));
      const run = await runJsmAlerts(
        ctxFor(db, {}),
        { ...CREDS, baseUrl: "https://jira.corp.example" },
        {},
        NOW,
      );
      expect(urls).toEqual([]);
      expect(run.fields.alAt).toBe(NOW);
      expect(run.upserted).toBe(0);
    } finally {
      db.close();
    }
  });

  test("an atlassian.net site with no stored id looks the cloud id up once and returns it in the fields", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub((u) => {
        if (u.pathname === "/_edge/tenant_info") return json({ cloudId: CID });
        return u.pathname.endsWith("/alerts") ? json({ values: [] }) : undefined;
      });
      const run = await runJsmAlerts(ctxFor(db, {}), CREDS, {}, NOW);
      expect(urls.filter((u) => u.endsWith("/_edge/tenant_info"))).toHaveLength(1);
      expect(run.fields.cid).toBe(CID);
      expect(run.fields.cidSite).toBe(SITE);
    } finally {
      db.close();
    }
  });

  test("a malformed stored cloud id is ignored", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub(() => json({}));
      await runJsmAlerts(
        ctxFor(db, { "jira.cloud_id": "not-a-uuid" }),
        { ...CREDS, baseUrl: "https://jira.corp.example" },
        {},
        NOW,
      );
      expect(urls).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a cloud id cached in the cursor for the same site is reused without a lookup", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub((u) =>
        u.pathname.endsWith("/alerts") ? json({ values: [] }) : undefined,
      );
      const run = await runJsmAlerts(ctxFor(db, {}), CREDS, { cid: CID, cidSite: SITE }, NOW);
      expect(urls.some((u) => u.includes("tenant_info"))).toBe(false);
      // Already in the cursor: not re-emitted by the alert pass.
      expect(run.fields.cid).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("an id that left the complete open listing is refetched and updated to closed", async () => {
    const db = createMemoryIndexDb();
    try {
      const { alertUrls } = stub((u) => {
        if (u.pathname.endsWith("/alerts/gone")) {
          return json({ data: alert("gone", { status: "closed", report: { closeTime: 1000 } }) });
        }
        if (query(u) === "status:open") return json({ values: [alert("still")] });
        return query(u) === "status:closed" ? json({ values: [] }) : undefined;
      });
      const run = await runJsmAlerts(ctxFor(db), CREDS, { alOpen: ["still", "gone"] }, NOW);
      expect(alertUrls.some((u) => u.endsWith("/alerts/gone"))).toBe(true);
      const gone = stored(db).find((r) => r.external_id === "gone");
      expect(JSON.parse(gone?.metadata ?? "{}")["status"]).toBe("closed");
      expect(run.fields.alOpen).toEqual(["still"]);
    } finally {
      db.close();
    }
  });

  test("a failed refetch leaves the row and keeps the id for the next pass", async () => {
    const db = createMemoryIndexDb();
    try {
      stub((u) => {
        if (u.pathname.endsWith("/alerts/gone")) return new Response("{}", { status: 500 });
        if (query(u) === "status:open") return json({ values: [] });
        return query(u) === "status:closed" ? json({ values: [] }) : undefined;
      });
      const run = await runJsmAlerts(ctxFor(db), CREDS, { alOpen: ["gone"] }, NOW);
      expect(run.fields.alOpen).toEqual(["gone"]);
      expect(stored(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("reconciliation is capped at 20 refetches and skips an unsafe id", async () => {
    const db = createMemoryIndexDb();
    try {
      const { alertUrls } = stub((u) => {
        if (/\/alerts\/g\d+$/.test(u.pathname)) {
          return json(alert(u.pathname.split("/").pop() ?? "x", { status: "closed" }));
        }
        if (query(u) === "status:open") return json({ values: [] });
        return query(u) === "status:closed" ? json({ values: [] }) : undefined;
      });
      const ids = [...Array.from({ length: 30 }, (_, i) => `g${String(i)}`), "../escape"];
      await runJsmAlerts(ctxFor(db), CREDS, { alOpen: ["../escape", ...ids] }, NOW);
      expect(alertUrls.filter((u) => /\/alerts\/g\d+$/.test(u))).toHaveLength(20);
      expect(alertUrls.some((u) => u.includes("escape"))).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a malformed page entry makes the open listing incomplete, so nothing is reconciled", async () => {
    const db = createMemoryIndexDb();
    try {
      const { alertUrls } = stub((u) => {
        if (query(u) === "status:open") return json({ values: [alert("o1"), { no: "id" }] });
        return query(u) === "status:closed" ? json({ values: [] }) : undefined;
      });
      const run = await runJsmAlerts(ctxFor(db), CREDS, { alOpen: ["x"] }, NOW);
      expect(alertUrls.some((u) => u.endsWith("/alerts/x"))).toBe(false);
      expect(run.fields.alOpen).toEqual(["o1", "x"]);
    } finally {
      db.close();
    }
  });

  test("an expired 60 s budget ends the pass partial and does not throw", async () => {
    const db = createMemoryIndexDb();
    try {
      stub(() => json({ values: [alert("o1")] }));
      let t = 0;
      const clock = (): number => {
        t += JSM_STEP_BUDGET_MS; // every reading burns the whole budget
        return t;
      };
      const run = await runJsmAlerts(ctxFor(db), CREDS, {}, NOW, clock);
      expect(run.fields.alAt).toBe(NOW);
      expect(run.upserted).toBe(0);
    } finally {
      db.close();
    }
  });

  test("a non-list reply is a failed page, not a throw", async () => {
    const db = createMemoryIndexDb();
    try {
      stub(() => json({ unexpected: true }));
      const run = await runJsmAlerts(ctxFor(db), CREDS, {}, NOW);
      expect(run.upserted).toBe(0);
      expect(run.fields.alUntil).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("an unmappable record (no timestamps) is skipped and counted, the rest are written", async () => {
    const db = createMemoryIndexDb();
    try {
      stub((u) => {
        if (query(u) === "status:open") {
          return json({ values: [alert("ok"), { id: "no-time", status: "open" }] });
        }
        return query(u) === "status:closed" ? json({ values: [] }) : undefined;
      });
      const run = await runJsmAlerts(ctxFor(db), CREDS, {}, NOW);
      expect(stored(db).map((r) => r.external_id)).toEqual(["ok"]);
      expect(run.upserted).toBe(1);
    } finally {
      db.close();
    }
  });
});
