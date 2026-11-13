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
import { createJiraSyncable } from "./jira-sync.ts";
import { JSM_ALERT_REFRESH_INTERVAL_MS } from "./jsm-alerts.ts";
import { JSM_UNAVAILABLE_BACKOFF_MS } from "./jsm-oncall.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const PREFIX = "nimbus-jra1:";
const SITE = "https://acme.atlassian.net";
const CID = "0123abcd-0123-4abc-8abc-0123456789ab";
const OPS = `https://api.atlassian.com/jsm/ops/api/${CID}/v1`;
const MIN = 60_000;

type Db = ReturnType<typeof createMemoryIndexDb>;

function ctxFor(db: Db): SyncContext {
  const vault = createStubVault({
    "jira.email": "u@acme.com",
    "jira.api_token": "tok",
    "jira.base_url": SITE,
    "jira.cloud_id": CID,
  });
  return {
    ...syncTestContext(db, vault, "jira"),
    rateLimiter: new ProviderRateLimiter({ jira: { requestsPerMinute: 60_000, burstSize: 100 } }),
  };
}

const NOW_ISO = (): string => new Date().toISOString();

function stub(alertsStatus = 200): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = urlFromFetchInput(input);
    urls.push(url);
    if (url.endsWith("/rest/api/3/search")) {
      return new Response(JSON.stringify({ issues: [], startAt: 0, total: 0 }));
    }
    if (url === `${SITE}/rest/api/3/myself`) return new Response('{"accountId":"a"}');
    if (url === `${OPS}/schedules`) return new Response('{"values":[{"id":"s1","name":"P"}]}');
    if (url.endsWith("/on-calls") && !url.endsWith("/next-on-calls")) {
      return new Response('{"onCallParticipants":[{"id":"a","name":"Al","type":"user"}]}');
    }
    if (url.endsWith("/next-on-calls")) return new Response('{"nextOnCallParticipants":[]}');
    if (url.startsWith(`${OPS}/alerts`)) {
      if (alertsStatus !== 200) return new Response("{}", { status: alertsStatus });
      const u = new URL(url);
      const open = u.searchParams.get("query") === "status:open";
      return new Response(
        JSON.stringify({
          values: open
            ? [
                {
                  id: "al-1",
                  message: "boom",
                  status: "open",
                  createdAt: NOW_ISO(),
                  updatedAt: NOW_ISO(),
                },
              ]
            : [],
        }),
      );
    }
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { urls };
}

function rec(cursor: string | null): Record<string, unknown> {
  return decodeNimbusJsonCursorObject(cursor, PREFIX) ?? {};
}

const alertReqs = (urls: string[]): string[] => urls.filter((u) => u.startsWith(`${OPS}/alerts`));

describeWithFetchRestore("jira alert pass pacing (Phase 10 IC2)", () => {
  const syncable = () => createJiraSyncable({ ensureJiraMcpRunning: async () => {} });

  test("a first sync indexes the alert and records alAt and alOpen beside the on-call keys", async () => {
    const db = createMemoryIndexDb();
    try {
      stub();
      const r = await syncable().sync(ctxFor(db), null);
      const c = rec(r.cursor);
      expect(typeof c["alAt"]).toBe("number");
      expect(c["alOpen"]).toEqual(["al-1"]);
      // Both passes' keys survive in one cursor, sharing the cloud id.
      expect(typeof c["ocAt"]).toBe("number");
      expect(typeof c["snapAt"]).toBe("number");
      expect(c["cid"]).toBe(CID);
      expect(db.query("SELECT COUNT(*) AS n FROM item WHERE id = 'jira:al-1'").get()).toEqual({
        n: 1,
      });
    } finally {
      db.close();
    }
  });

  test("a second sync inside five minutes makes no alert request; after the interval it runs again", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub();
      const first = await syncable().sync(ctxFor(db), null);
      urls.length = 0;
      const second = await syncable().sync(ctxFor(db), first.cursor);
      expect(alertReqs(urls)).toEqual([]);
      // The cursor rewrite keeps every key the first run recorded, and the issue floor still moves.
      expect(rec(second.cursor)["alAt"]).toBe(rec(first.cursor)["alAt"]);
      expect(rec(second.cursor)["alOpen"]).toEqual(["al-1"]);
      const old = encodeNimbusJsonCursor(PREFIX, {
        ...rec(first.cursor),
        alAt: Date.now() - (JSM_ALERT_REFRESH_INTERVAL_MS + MIN),
      });
      await syncable().sync(ctxFor(db), old);
      expect(alertReqs(urls).length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("a failing provider is retried once per interval: alAt is an attempt", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub(500);
      const first = await syncable().sync(ctxFor(db), null);
      expect(typeof rec(first.cursor)["alAt"]).toBe("number");
      expect(rec(first.cursor)["alUntil"]).toBeUndefined();
      urls.length = 0;
      await syncable().sync(ctxFor(db), first.cursor);
      expect(alertReqs(urls)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a 403 sets alUntil and no alert request is made inside the backoff", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub(403);
      const first = await syncable().sync(ctxFor(db), null);
      const until = rec(first.cursor)["alUntil"];
      expect(typeof until).toBe("number");
      expect((until as number) - Date.now()).toBeGreaterThan(JSM_UNAVAILABLE_BACKOFF_MS - MIN);
      urls.length = 0;
      const due = encodeNimbusJsonCursor(PREFIX, { ...rec(first.cursor), alAt: 1 });
      await syncable().sync(ctxFor(db), due);
      expect(alertReqs(urls)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a corrupt alUntil beyond six hours is ignored", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub();
      const cur = encodeNimbusJsonCursor(PREFIX, {
        v: 1,
        floorJql: null,
        alAt: 1,
        alUntil: Date.now() + 365 * 24 * 60 * MIN,
      });
      await syncable().sync(ctxFor(db), cur);
      expect(alertReqs(urls).length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("the pass never throws into the sync: a rejecting fetch for alerts still returns the issue sync result", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub();
      const base = globalThis.fetch;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (urlFromFetchInput(input).startsWith(`${OPS}/alerts`)) throw new Error("boom");
        return base(input, init);
      }) as typeof fetch;
      const r = await syncable().sync(ctxFor(db), null);
      expect(r.cursor).not.toBeNull();
      expect(typeof rec(r.cursor)["alAt"]).toBe("number");
      expect(urls.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("a stored alert-pass failure outside the request path is caught and logged", async () => {
    const db = createMemoryIndexDb();
    try {
      stub();
      const ctx = ctxFor(db);
      const warns: string[] = [];
      const broken: SyncContext = {
        ...ctx,
        logger: { ...ctx.logger, warn: ((_: unknown, m?: string) => warns.push(m ?? "")) as never },
        writeBatch: () => {
          throw new Error("db locked");
        },
      };
      const r = await syncable().sync(broken, null);
      expect(typeof rec(r.cursor)["alAt"]).toBe("number");
      expect(warns.some((m) => m.includes("jsm alerts refresh failed"))).toBe(true);
    } finally {
      db.close();
    }
  });
});
