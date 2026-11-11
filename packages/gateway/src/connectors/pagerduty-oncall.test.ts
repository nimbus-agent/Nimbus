import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  silentSyncContextExtras,
  syncTestContext,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { parseMe, parsePdPage, pdEntryToShift, runPagerdutyOncall } from "./pagerduty-oncall.ts";

const NOW = Date.UTC(2026, 10, 11, 9, 0);
const HOST = "https://api.pagerduty.com";

type Reply = { status?: number; body?: unknown; text?: string };
type Handler = (url: URL, init: RequestInit | undefined) => Reply | undefined;

function install(handler: Handler): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = urlFromFetchInput(input);
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    const r = handler(new URL(url), init);
    if (r === undefined) throw new Error(`unexpected fetch: ${url}`);
    return new Response(r.text ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls };
}

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    escalation_policy: { id: "EP1", summary: "Payments policy", html_url: "https://pd/ep1" },
    escalation_level: 1,
    schedule: { id: "S1", summary: "Payments primary", html_url: "https://pd/s1" },
    user: { id: "U1", name: "Alice Ng", email: "alice@example.com" },
    start: "2026-11-11T08:00:00Z",
    end: "2026-11-12T08:00:00Z",
    ...over,
  };
}

const SERVICES = {
  services: [
    { id: "P1", name: "payment-service", escalation_policy: { id: "EP1" } },
    { id: "P2", name: "checkout-web", escalation_policy: { id: "EP1" } },
  ],
  more: false,
};

function standard(oncalls: unknown[], over: Record<string, Handler> = {}): Handler {
  return (url, init) => {
    const custom = over[url.pathname];
    if (custom !== undefined) return custom(url, init);
    if (url.pathname === "/users/me") return { body: { user: { id: "U1", email: "me@x.com" } } };
    if (url.pathname === "/oncalls") return { body: { oncalls, more: false } };
    if (url.pathname === "/services") return { body: SERVICES };
    return undefined;
  };
}

function ctxFor(db: Database, secrets: Record<string, string> = {}): SyncContext {
  return syncTestContext(db, createStubVault(secrets), "pagerduty");
}

function shiftRows(
  db: Database,
  service = "pagerduty",
): Array<{ external_id: string; title: string; meta: Record<string, unknown> }> {
  const rows = db
    .query(
      "SELECT external_id, title, metadata FROM item WHERE service = ? AND type = 'oncall_shift' ORDER BY external_id",
    )
    .all(service) as Array<{ external_id: string; title: string; metadata: string }>;
  return rows.map((r) => ({
    external_id: r.external_id,
    title: r.title,
    meta: JSON.parse(r.metadata) as Record<string, unknown>,
  }));
}

function insertIncident(db: Database): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('pagerduty:PINC', 'pagerduty', 'incident', 'PINC', 't', 1, 1)`,
  );
}

describeWithFetchRestore("pagerduty oncall refresh", () => {
  test("request shape: three ordered requests, headers, includes and window", async () => {
    const db = createMemoryIndexDb();
    try {
      const { calls } = install(standard([entry()]));
      const acquired: string[] = [];
      const limiter = new ProviderRateLimiter();
      const orig = limiter.acquire.bind(limiter);
      limiter.acquire = async (p, n) => {
        acquired.push(p);
        await orig(p, n);
      };
      const ctx = { ...ctxFor(db), rateLimiter: limiter };
      await runPagerdutyOncall(ctx, " tok ", NOW);
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
        "/users/me",
        "/oncalls",
        "/services",
      ]);
      expect(acquired).toEqual(["pagerduty", "pagerduty", "pagerduty"]);
      for (const c of calls) {
        expect(c.url.startsWith(HOST)).toBe(true);
        const h = c.init?.headers as Record<string, string>;
        expect(h["Authorization"]).toBe("Token token=tok");
        expect(h["Accept"]).toBe("application/vnd.pagerduty+json;version=2");
        expect(c.init?.redirect).toBe("manual");
      }
      const oc = new URL(calls[1]?.url ?? "");
      expect(oc.searchParams.get("limit")).toBe("100");
      expect(oc.searchParams.get("offset")).toBe("0");
      expect(oc.searchParams.getAll("include[]")).toEqual([
        "users",
        "escalation_policies",
        "schedules",
      ]);
      expect(oc.searchParams.get("since")).toBe(new Date(NOW).toISOString());
      expect(oc.searchParams.get("until")).toBe(new Date(NOW + 7 * 86_400_000).toISOString());
      expect(new URL(calls[2]?.url ?? "").searchParams.getAll("include[]")).toEqual([
        "escalation_policies",
      ]);
    } finally {
      db.close();
    }
  });

  test("maps an entry to a row with every metadata key and the service map", async () => {
    const db = createMemoryIndexDb();
    try {
      install(standard([entry()]));
      const out = await runPagerdutyOncall(ctxFor(db), "t", NOW);
      expect(out).toEqual({ complete: true, upserted: 1, deleted: 0 });
      const [row] = shiftRows(db);
      expect(row?.title).toBe(
        "On call: Alice Ng — Payments primary (level 1) until 2026-11-12 08:00 UTC",
      );
      expect(row?.meta).toMatchObject({
        source: "pagerduty",
        user_name: "Alice Ng",
        user_email: "alice@example.com",
        escalation_policy_id: "EP1",
        escalation_policy_name: "Payments policy",
        escalation_level: 1,
        schedule_id: "S1",
        schedule_name: "Payments primary",
        start_ms: Date.UTC(2026, 10, 11, 8, 0),
        end_ms: Date.UTC(2026, 10, 12, 8, 0),
        service_ids: ["P1", "P2"],
        service_names: ["payment-service", "checkout-web"],
        service_map_complete: true,
        is_me: true,
        fetched_at_ms: NOW,
      });
    } finally {
      db.close();
    }
  });

  test("an always-on entry (no schedule, no times) and an entry with no user", async () => {
    const db = createMemoryIndexDb();
    try {
      install(
        standard([
          entry({ schedule: null, start: null, end: null, user: { id: "U2", name: "Bob" } }),
          entry({ user: null }),
          "junk",
        ]),
      );
      const out = await runPagerdutyOncall(ctxFor(db), "t", NOW);
      expect(out.upserted).toBe(1);
      const [row] = shiftRows(db);
      expect(row?.title).toBe("On call: Bob — Payments policy (level 1)");
      expect("start_ms" in (row?.meta ?? {})).toBe(false);
      expect("user_email" in (row?.meta ?? {})).toBe(false);
      expect(row?.meta["is_me"]).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a policy with no services gets empty lists", async () => {
    const db = createMemoryIndexDb();
    try {
      install(standard([entry({ escalation_policy: { id: "EPX", summary: "Other" } })]));
      await runPagerdutyOncall(ctxFor(db), "t", NOW);
      expect(shiftRows(db)[0]?.meta).toMatchObject({ service_ids: [], service_names: [] });
    } finally {
      db.close();
    }
  });

  test("is_me falls back to from_email when /users/me answers 400, case-insensitively", async () => {
    const db = createMemoryIndexDb();
    try {
      install(standard([entry()], { "/users/me": () => ({ status: 400 }) }));
      await runPagerdutyOncall(
        ctxFor(db, { "pagerduty.from_email": "ALICE@example.com" }),
        "t",
        NOW,
      );
      expect(shiftRows(db)[0]?.meta["is_me"]).toBe(true);
    } finally {
      db.close();
    }
  });

  test("is_me is false when /users/me fails and there is no from_email, and on a network error", async () => {
    const db = createMemoryIndexDb();
    try {
      install(
        standard([entry()], {
          "/users/me": () => {
            throw new Error("net");
          },
        }),
      );
      await runPagerdutyOncall(ctxFor(db), "t", NOW);
      expect(shiftRows(db)[0]?.meta["is_me"]).toBe(false);
    } finally {
      db.close();
    }
  });

  test("/users/me with a body that is not a user falls back too", async () => {
    const db = createMemoryIndexDb();
    try {
      install(standard([entry()], { "/users/me": () => ({ text: "not json" }) }));
      await runPagerdutyOncall(
        ctxFor(db, { "pagerduty.from_email": "alice@example.com" }),
        "t",
        NOW,
      );
      expect(shiftRows(db)[0]?.meta["is_me"]).toBe(true);
    } finally {
      db.close();
    }
  });

  test("two oncalls pages are walked with offset 0 then 100", async () => {
    const db = createMemoryIndexDb();
    try {
      const { calls } = install(
        standard([], {
          "/oncalls": (url) =>
            url.searchParams.get("offset") === "0"
              ? { body: { oncalls: [entry()], more: true } }
              : { body: { oncalls: [entry({ user: { id: "U3", name: "Cy" } })], more: false } },
        }),
      );
      const out = await runPagerdutyOncall(ctxFor(db), "t", NOW);
      expect(out.complete).toBe(true);
      expect(out.upserted).toBe(2);
      const offsets = calls
        .filter((c) => c.url.includes("/oncalls"))
        .map((c) => new URL(c.url).searchParams.get("offset"));
      expect(offsets).toEqual(["0", "100"]);
    } finally {
      db.close();
    }
  });

  test("a page cap deletes nothing and is partial", async () => {
    const db = createMemoryIndexDb();
    try {
      const old = ctxFor(db);
      install(standard([entry({ user: { id: "OLD", name: "Old" } })]));
      await runPagerdutyOncall(old, "t", NOW);
      const warnings: unknown[] = [];
      const logged = {
        ...old,
        rateLimiter: new ProviderRateLimiter({
          pagerduty: { requestsPerMinute: 6000, burstSize: 100 },
        }),
        logger: {
          ...old.logger,
          info: (o: unknown) => warnings.push(o),
        } as unknown as SyncContext["logger"],
      };
      const { calls } = install(
        standard([], {
          "/oncalls": () => ({ body: { oncalls: [entry()], more: true } }),
        }),
      );
      const out = await runPagerdutyOncall(logged, "t", NOW + 1);
      expect(out).toMatchObject({ complete: false, deleted: 0 });
      expect(calls.filter((c) => c.url.includes("/oncalls"))).toHaveLength(10);
      expect(
        shiftRows(db)
          .map((r) => r.meta["user_name"])
          .sort(),
      ).toEqual(["Alice Ng", "Old"]);
      expect(JSON.stringify(warnings)).toContain('"oncall_partial":true');
    } finally {
      db.close();
    }
  });

  test("a services cap marks the map incomplete but the replace still runs", async () => {
    const db = createMemoryIndexDb();
    try {
      const fast = new ProviderRateLimiter({
        pagerduty: { requestsPerMinute: 6000, burstSize: 100 },
      });
      const { calls } = install(
        standard([entry()], {
          "/services": () => ({ body: { services: [], more: true } }),
        }),
      );
      const out = await runPagerdutyOncall({ ...ctxFor(db), rateLimiter: fast }, "t", NOW);
      expect(out.complete).toBe(true);
      expect(calls.filter((c) => c.url.includes("/services"))).toHaveLength(5);
      expect(shiftRows(db)[0]?.meta["service_map_complete"]).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a failing services request is not partial for the shift set", async () => {
    const db = createMemoryIndexDb();
    try {
      install(standard([entry()], { "/services": () => ({ status: 500 }) }));
      const out = await runPagerdutyOncall(ctxFor(db), "t", NOW);
      expect(out.complete).toBe(true);
      expect(shiftRows(db)[0]?.meta).toMatchObject({
        service_ids: [],
        service_map_complete: false,
      });
    } finally {
      db.close();
    }
  });

  test("a second refresh deletes a vanished shift and leaves incidents and other services alone", async () => {
    const db = createMemoryIndexDb();
    try {
      insertIncident(db);
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
         VALUES ('jira:oncall:jsm:x', 'jira', 'oncall_shift', 'oncall:jsm:x', 't', 1, 1)`,
      );
      install(standard([entry(), entry({ user: { id: "U9", name: "Zed" } })]));
      await runPagerdutyOncall(ctxFor(db), "t", NOW);
      expect(shiftRows(db)).toHaveLength(2);
      install(standard([entry()]));
      const out = await runPagerdutyOncall(ctxFor(db), "t", NOW + 1);
      expect(out.deleted).toBe(1);
      expect(shiftRows(db)).toHaveLength(1);
      expect(shiftRows(db, "jira")).toHaveLength(1);
      expect(db.query("SELECT COUNT(*) AS n FROM item WHERE type = 'incident'").get()).toEqual({
        n: 1,
      });
    } finally {
      db.close();
    }
  });

  test("a valid empty complete reply deletes every shift", async () => {
    const db = createMemoryIndexDb();
    try {
      install(standard([entry()]));
      await runPagerdutyOncall(ctxFor(db), "t", NOW);
      install(standard([]));
      const out = await runPagerdutyOncall(ctxFor(db), "t", NOW + 1);
      expect(out).toEqual({ complete: true, upserted: 0, deleted: 1 });
      expect(shiftRows(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("a failing second page or invalid JSON deletes nothing and keeps fetched_at_ms", async () => {
    const db = createMemoryIndexDb();
    try {
      install(standard([entry()]));
      await runPagerdutyOncall(ctxFor(db), "t", NOW);
      for (const bad of [{ status: 500 }, { text: "{nope" }, { body: { oncalls: "x" } }]) {
        install(
          standard([], {
            "/oncalls": (url) =>
              url.searchParams.get("offset") === "0" ? { body: { oncalls: [], more: true } } : bad,
          }),
        );
        const out = await runPagerdutyOncall(ctxFor(db), "t", NOW + 5);
        expect(out.complete).toBe(false);
        expect(out.deleted).toBe(0);
      }
      expect(shiftRows(db)).toHaveLength(1);
      expect(shiftRows(db)[0]?.meta["fetched_at_ms"]).toBe(NOW);
    } finally {
      db.close();
    }
  });

  test("a non-boolean or missing `more` is a parse failure: partial, nothing deleted", async () => {
    const db = createMemoryIndexDb();
    try {
      install(standard([entry()]));
      await runPagerdutyOncall(ctxFor(db), "t", NOW);
      for (const body of [
        { oncalls: [], more: "true" },
        { oncalls: [], more: 1 },
        { oncalls: [] },
      ]) {
        install(standard([], { "/oncalls": () => ({ body }) }));
        const out = await runPagerdutyOncall(ctxFor(db), "t", NOW + 5);
        expect(out.complete).toBe(false);
        expect(out.deleted).toBe(0);
      }
      expect(shiftRows(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("an unreadable entry makes the snapshot partial: valid rows upserted, nothing deleted", async () => {
    const db = createMemoryIndexDb();
    try {
      install(standard([entry(), entry({ user: { id: "U2", name: "Old" } })]));
      await runPagerdutyOncall(ctxFor(db), "t", NOW);
      expect(shiftRows(db)).toHaveLength(2);
      install(standard([entry(), { user: {} }]));
      const out = await runPagerdutyOncall(ctxFor(db), "t", NOW + 1);
      expect(out).toEqual({ complete: false, upserted: 1, deleted: 0 });
      expect(shiftRows(db)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("429 penalises the limiter and 401 does not throw; nothing is deleted", async () => {
    const db = createMemoryIndexDb();
    try {
      install(standard([entry()]));
      await runPagerdutyOncall(ctxFor(db), "t", NOW);
      const penalised: string[] = [];
      const limiter = new ProviderRateLimiter();
      limiter.penalise = (p) => {
        penalised.push(p);
      };
      const ctx = { ...ctxFor(db), rateLimiter: limiter };
      install(() => ({ status: 429 }));
      expect((await runPagerdutyOncall(ctx, "t", NOW + 1)).complete).toBe(false);
      expect(penalised.length).toBeGreaterThan(0);
      install(() => ({ status: 401 }));
      expect((await runPagerdutyOncall(ctx, "t", NOW + 2)).deleted).toBe(0);
      expect(shiftRows(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("an oversized page body is refused", async () => {
    const db = createMemoryIndexDb();
    try {
      install(
        standard([], {
          "/oncalls": () => ({ text: `{"oncalls":[],"pad":"${"x".repeat(2 * 1024 * 1024)}"}` }),
        }),
      );
      expect((await runPagerdutyOncall(ctxFor(db), "t", NOW)).complete).toBe(false);
    } finally {
      db.close();
    }
  });
});

describeWithFetchRestore("pagerduty oncall parsers", () => {
  test("parsePdPage and parseMe reject the wrong shape", () => {
    expect(parsePdPage("[]", "x")).toBeNull();
    expect(parsePdPage('{"x": 1}', "x")).toBeNull();
    expect(parsePdPage('{"x": [1], "more": true}', "x")).toEqual({ items: [1], more: true });
    expect(parseMe("{}")).toBeNull();
    expect(parseMe("nope")).toBeNull();
    expect(parseMe('{"user":{"id":"","email":"bad"}}')).toEqual({ id: null, email: null });
  });

  test("pdEntryToShift handles non-records and an entry with a bare user", () => {
    const services = { ids: new Map(), names: new Map(), complete: true };
    const me = { id: null, email: null };
    expect(pdEntryToShift(5, me, services)).toBeNull();
    const s = pdEntryToShift(
      { user: { id: "U" }, escalation_policy: { id: "E", html_url: "u" } },
      me,
      services,
    );
    expect(s).toMatchObject({ userName: "U", url: "u", scheduleName: null, level: null });
    expect(silentSyncContextExtras().depth).toBe("full");
  });
});
