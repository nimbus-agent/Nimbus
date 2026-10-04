/**
 * Workday's degraded paths that `workday-sync.test.ts` does not reach: a cursor whose offsets are
 * not numbers, domains whose walk throws, a domain page that is not JSON, and RaaS reports with an
 * unparseable URL, a non-JSON body, non-record rows, or a request that throws — plus the
 * production token path, where no `loadAccessToken` override is given and the sync context
 * supplies the token.
 *
 * Everything goes through `createWorkdaySyncable` with its injected `fetchFn` / token loader.
 */
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import pino, { type Logger } from "pino";

import type { NimbusWorkdayToml } from "../config/nimbus-toml-workday.ts";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { createWorkdaySyncable } from "./workday-sync.ts";

const CURSOR_PREFIX = "nimbus-workday1:";
const TENANT_HOST = "https://wd5.workday.com";
const REPORT_BASE = `${TENANT_HOST}/ccx/service/customreport2/acme/ISU`;

type Route = { body?: unknown; text?: string; status?: number; throws?: string };

/** Routes by substring; anything unrouted answers 404. Records every URL requested. */
function routedFetch(routes: Record<string, Route>): { fetchFn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const u = String(input);
    urls.push(u);
    const key = Object.keys(routes).find((k) => u.includes(k));
    const r = key === undefined ? undefined : routes[key];
    if (r === undefined) return new Response("not found", { status: 404 });
    if (r.throws !== undefined) throw new Error(r.throws);
    if (r.text !== undefined) return new Response(r.text, { status: r.status ?? 200 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, urls };
}

const EMPTY_DOMAINS: Record<string, Route> = {
  "/workers": { body: { data: [] } },
  "/timeOff": { body: { data: [] } },
  "/jobRequisitions": { body: { data: [] } },
};

type LogLine = { level: number; msg: string; [k: string]: unknown };

function runWorkday(
  db: Database,
  opts: {
    routes: Record<string, Route>;
    reports?: NimbusWorkdayToml["reports"];
    cursor?: string | null;
  },
) {
  const raw: string[] = [];
  const logger: Logger = pino({ level: "warn" }, { write: (s: string) => raw.push(s) });
  const { fetchFn, urls } = routedFetch(opts.routes);
  const syncable = createWorkdaySyncable({
    ensureWorkdayMcpRunning: async () => {},
    loadAccessToken: async () => "tok",
    loadWorkdayConfig: () => ({ timeOffHistoryDays: 30, reports: opts.reports ?? [] }),
    tenantHost: TENANT_HOST,
    fetchFn,
  });
  const ctx = { ...syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday"), logger };
  return {
    run: syncable.sync(ctx, opts.cursor ?? null),
    urls,
    logs: () => raw.map((s) => JSON.parse(s) as LogLine),
  };
}

function offsets(cursor: string | null): Record<string, unknown> {
  return decodeNimbusJsonCursorPayload(cursor ?? "", CURSOR_PREFIX) as Record<string, unknown>;
}

function offsetParam(urls: readonly string[], path: string): string | null {
  const u = urls.find((x) => x.includes(path));
  return u === undefined ? null : new URL(u).searchParams.get("offset");
}

describe("cursor and domain walks", () => {
  test("a cursor whose offsets are not numbers restarts every domain at 0", async () => {
    const db = createMemoryIndexDb();
    const cursor = encodeNimbusJsonCursor(CURSOR_PREFIX, {
      workerOffset: "50",
      timeOffOffset: null,
      jobPostingOffset: true,
    });
    const { run, urls } = runWorkday(db, { routes: EMPTY_DOMAINS, cursor });

    const r = await run;

    expect(offsetParam(urls, "/workers")).toBe("0");
    expect(offsetParam(urls, "/timeOff")).toBe("0");
    expect(offsetParam(urls, "/jobRequisitions")).toBe("0");
    expect(offsets(r.cursor)).toEqual({ workerOffset: 0, timeOffOffset: 0, jobPostingOffset: 0 });
    db.close();
  });

  test("domains whose walk throws keep their offsets while the working domain advances", async () => {
    const db = createMemoryIndexDb();
    const cursor = encodeNimbusJsonCursor(CURSOR_PREFIX, {
      workerOffset: 100,
      timeOffOffset: 7,
      jobPostingOffset: 200,
    });
    const { run, logs } = runWorkday(db, {
      cursor,
      routes: {
        "/workers": { throws: "ECONNRESET" },
        "/timeOff": {
          body: {
            data: [
              {
                id: "t1",
                worker: "Ada",
                type: "PTO",
                startDate: "2026-01-01",
                endDate: "2026-01-02",
                status: "Approved",
              },
            ],
          },
        },
        "/jobRequisitions": { throws: "socket hang up" },
      },
    });

    const r = await run;

    expect(r.itemsUpserted).toBe(1);
    expect(offsets(r.cursor)).toEqual({
      workerOffset: 100,
      timeOffOffset: 8,
      jobPostingOffset: 200,
    });
    const msgs = logs().map((l) => l.msg);
    expect(msgs).toContain("workers domain error; continuing");
    expect(msgs).toContain("jobRequisitions domain error; continuing");
    expect(msgs).not.toContain("timeOff domain error; continuing");
    db.close();
  });

  test("a domain page that is not JSON ends that domain quietly after one request", async () => {
    const db = createMemoryIndexDb();
    const { run, urls, logs } = runWorkday(db, {
      routes: { ...EMPTY_DOMAINS, "/workers": { text: "<html>login</html>" } },
    });

    const r = await run;

    expect(r.itemsUpserted).toBe(0);
    expect(urls.filter((u) => u.includes("/workers"))).toHaveLength(1);
    // Unlike an HTTP failure, a malformed body is not reported as a failed fetch — and it is
    // handled inside the page fetch, never escaping as a domain crash.
    expect(logs().some((l) => l.msg === "workday domain fetch failed")).toBe(false);
    expect(logs().some((l) => l.msg === "workers domain error; continuing")).toBe(false);
    expect(offsets(r.cursor)["workerOffset"]).toBe(0);
    db.close();
  });
});

describe("RaaS reports", () => {
  test("a report URL that cannot be parsed is skipped as off-tenant, without a request", async () => {
    const db = createMemoryIndexDb();
    const { run, urls, logs } = runWorkday(db, {
      routes: EMPTY_DOMAINS,
      reports: [{ label: "bad", url: "not a url" }],
    });

    await run;

    expect(urls).not.toContain("not a url");
    const skipped = logs().filter(
      (l) => l.msg === "workday report url host does not match tenant host; skipping",
    );
    expect(skipped.map((l) => l["reportLabel"])).toEqual(["bad"]);
    db.close();
  });

  test("a report body that is not JSON is skipped with a warning, and the next report still lands", async () => {
    const db = createMemoryIndexDb();
    const { run, logs } = runWorkday(db, {
      routes: {
        ...EMPTY_DOMAINS,
        "/ISU/BROKEN": { text: "oops" },
        // Non-record rows cannot be mapped and are skipped; the one record row is indexed.
        "/ISU/HC": {
          body: { Report_Entry: ["just text", 5, null, { org: "Eng", headcount: 12 }] },
        },
      },
      reports: [
        { label: "broken", url: `${REPORT_BASE}/BROKEN?format=json` },
        { label: "headcount", url: `${REPORT_BASE}/HC?format=json` },
      ],
    });

    const r = await run;

    expect(r.itemsUpserted).toBe(1);
    const invalid = logs().filter(
      (l) => l.msg === "workday report response is not valid JSON; skipping",
    );
    expect(invalid.map((l) => l["reportLabel"])).toEqual(["broken"]);
    const labels = (
      db.query("SELECT metadata FROM item WHERE service = 'workday' AND type = 'report'").all() as {
        metadata: string;
      }[]
    ).map((x) => (JSON.parse(x.metadata) as { reportLabel: string }).reportLabel);
    expect(labels).toEqual(["headcount"]);
    db.close();
  });

  test("a report request that throws is skipped with a warning instead of failing the sync", async () => {
    const db = createMemoryIndexDb();
    const { run, logs } = runWorkday(db, {
      routes: { ...EMPTY_DOMAINS, "/ISU/FLAKY": { throws: "ETIMEDOUT" } },
      reports: [{ label: "flaky", url: `${REPORT_BASE}/FLAKY?format=json` }],
    });

    const r = await run;

    expect(r.itemsUpserted).toBe(0);
    const errored = logs().filter((l) => l.msg === "workday report fetch error; skipping");
    expect(errored.map((l) => l["reportLabel"])).toEqual(["flaky"]);
    db.close();
  });
});

/**
 * Production never sets `loadAccessToken` (`assemble-sync-registrations.ts` does not), so there the
 * token comes from `ctx.accessToken()`. These override that member on the context rather than
 * leave the bound capability in place: the bound one resolves through the Workday OAuth resolver,
 * which another file in the same process may have `mock.module`d — and a token from such a mock
 * would send this run to whatever `fetch` it reached.
 */
describe("the token, when no loadAccessToken override is given", () => {
  function authRecordingFetch(): { fetchFn: typeof fetch; auth: string[] } {
    const auth: string[] = [];
    const fetchFn = (async (_input: string | URL, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get("authorization") ?? "<none>");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchFn, auth };
  }

  function syncableWithoutTokenLoader(fetchFn: typeof fetch) {
    return createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadWorkdayConfig: () => ({ timeOffHistoryDays: 30, reports: [] }),
      tenantHost: TENANT_HOST,
      fetchFn,
    });
  }

  test("comes from the sync context, once, and authorizes every domain request", async () => {
    const db = createMemoryIndexDb();
    const { fetchFn, auth } = authRecordingFetch();
    let tokenCalls = 0;
    const ctx = {
      ...syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday"),
      accessToken: (): Promise<string> => {
        tokenCalls += 1;
        return Promise.resolve("ctx-token");
      },
    };

    const r = await syncableWithoutTokenLoader(fetchFn).sync(ctx, null);
    db.close();

    expect(tokenCalls).toBe(1);
    // One empty page each from /workers, /timeOff and /jobRequisitions.
    expect(auth).toEqual(["Bearer ctx-token", "Bearer ctx-token", "Bearer ctx-token"]);
    expect(offsets(r.cursor)).toEqual({ workerOffset: 0, timeOffOffset: 0, jobPostingOffset: 0 });
  });

  test("a context that cannot produce one makes the run a no-op that sends nothing", async () => {
    const db = createMemoryIndexDb();
    const { fetchFn, auth } = authRecordingFetch();
    const prior = encodeNimbusJsonCursor(CURSOR_PREFIX, {
      workerOffset: 50,
      timeOffOffset: 0,
      jobPostingOffset: 0,
    });
    const ctx = {
      ...syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday"),
      accessToken: (): Promise<string> => Promise.reject(new Error("workday is not connected")),
    };

    const r = await syncableWithoutTokenLoader(fetchFn).sync(ctx, prior);
    db.close();

    expect(auth).toEqual([]);
    // The incoming cursor is handed back untouched, so the next connected run resumes from it.
    expect(r.cursor).toBe(prior);
    expect(r.itemsUpserted).toBe(0);
    expect(r.hasMore).toBe(false);
  });
});
