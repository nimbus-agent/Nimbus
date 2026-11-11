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
import { JSM_UNAVAILABLE_BACKOFF_MS } from "./jsm-oncall.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const PREFIX = "nimbus-jra1:";
const SITE = "https://acme.atlassian.net";
const CID = "0123abcd-0123-4abc-8abc-0123456789ab";
const OPS = `https://api.atlassian.com/jsm/ops/api/${CID}/v1`;
const MIN = 60_000;

function ctxFor(db: ReturnType<typeof createMemoryIndexDb>): SyncContext {
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

function stub(opsStatus = 200): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = urlFromFetchInput(input);
    urls.push(url);
    if (url.endsWith("/rest/api/3/search")) {
      return new Response(JSON.stringify({ issues: [], startAt: 0, total: 0 }));
    }
    if (url === `${SITE}/rest/api/3/myself`) return new Response('{"accountId":"a"}');
    if (url === `${OPS}/schedules`) {
      return opsStatus === 200
        ? new Response('{"values":[{"id":"s1","name":"Primary"}]}')
        : new Response("{}", { status: opsStatus });
    }
    if (url.endsWith("/on-calls") && !url.endsWith("/next-on-calls")) {
      return new Response('{"onCallParticipants":[{"id":"a","name":"Al","type":"user"}]}');
    }
    if (url.endsWith("/next-on-calls")) return new Response('{"nextOnCallParticipants":[]}');
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { urls };
}

function rec(cursor: string | null): Record<string, unknown> {
  return decodeNimbusJsonCursorObject(cursor, PREFIX) ?? {};
}

const ops = (urls: string[]): string[] => urls.filter((u) => u.includes("/jsm/ops/"));

describeWithFetchRestore("jira on-call refresh pacing (MB3)", () => {
  const syncable = () => createJiraSyncable({ ensureJiraMcpRunning: async () => {} });

  test("a first sync runs after the snapshot and records ocAt, cid and cidSite beside snapAt", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub();
      const r = await syncable().sync(ctxFor(db), null);
      expect(ops(urls).length).toBeGreaterThan(0);
      const c = rec(r.cursor);
      expect(typeof c["snapAt"]).toBe("number");
      expect(typeof c["ocAt"]).toBe("number");
      expect(c["cid"]).toBe(CID);
      expect(c["cidSite"]).toBe(SITE);
      expect(db.query("SELECT COUNT(*) AS n FROM item WHERE type = 'oncall_shift'").get()).toEqual({
        n: 1,
      });
    } finally {
      db.close();
    }
  });

  test("inside the interval no ops request is made and the fields round-trip; after it one is", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub();
      const now = Date.now();
      const cur = encodeNimbusJsonCursor(PREFIX, {
        v: 1,
        floorJql: null,
        snapAt: now,
        ocAt: now - 5 * MIN,
        cid: CID,
        cidSite: SITE,
      });
      const r = await syncable().sync(ctxFor(db), cur);
      expect(ops(urls)).toHaveLength(0);
      expect(rec(r.cursor)).toMatchObject({ ocAt: now - 5 * MIN, cid: CID, cidSite: SITE });
      const old = encodeNimbusJsonCursor(PREFIX, {
        v: 1,
        floorJql: null,
        snapAt: now,
        ocAt: now - 16 * MIN,
      });
      await syncable().sync(ctxFor(db), old);
      expect(ops(urls).length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("an old cursor without the on-call keys, and malformed ones, still decode and refresh", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub();
      const bad = encodeNimbusJsonCursor(PREFIX, {
        v: 1,
        floorJql: null,
        snapAt: Date.now(),
        ocAt: "soon",
        ocUntil: Number.NaN,
        cid: 5,
      });
      await syncable().sync(ctxFor(db), bad);
      expect(ops(urls).length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("inside ocUntil the step is skipped even with an old ocAt; a far-future ocUntil is ignored", async () => {
    const db = createMemoryIndexDb();
    try {
      const { urls } = stub();
      const now = Date.now();
      const base = { v: 1, floorJql: null, snapAt: now, ocAt: now - 20 * MIN };
      await syncable().sync(
        ctxFor(db),
        encodeNimbusJsonCursor(PREFIX, { ...base, ocUntil: now + 3_600_000 }),
      );
      expect(ops(urls)).toHaveLength(0);
      await syncable().sync(
        ctxFor(db),
        encodeNimbusJsonCursor(PREFIX, { ...base, ocUntil: now + 100 * 3_600_000 }),
      );
      expect(ops(urls).length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("an unavailable feature records ocUntil and the sync still succeeds", async () => {
    const db = createMemoryIndexDb();
    try {
      stub(403);
      const before = Date.now();
      const r = await syncable().sync(ctxFor(db), null);
      expect(Number(rec(r.cursor)["ocUntil"])).toBeGreaterThanOrEqual(
        before + JSM_UNAVAILABLE_BACKOFF_MS,
      );
      expect(r.itemsUpserted).toBe(0);
    } finally {
      db.close();
    }
  });

  test("a throw in the on-call step fails soft and still advances ocAt", async () => {
    const db = createMemoryIndexDb();
    try {
      stub();
      const ctx = {
        ...ctxFor(db),
        replaceItemSet: () => {
          throw new Error("boom");
        },
      };
      const r = await syncable().sync(ctx, null);
      expect(typeof rec(r.cursor)["ocAt"]).toBe("number");
    } finally {
      db.close();
    }
  });
});
