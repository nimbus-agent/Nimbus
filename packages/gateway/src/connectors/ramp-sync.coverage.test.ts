/**
 * Ramp's failure paths that the fake-server integration test does not reach: a token response
 * that is not JSON, a 401 whose re-exchange also fails, a first page that is not JSON, a later
 * page failing after earlier pages landed, and a page whose `data` is not a list.
 *
 * `fetch` is replaced by a per-URL QUEUE rather than `MockFetch`: the re-exchange calls the same
 * token URL with the same body twice and needs a different answer each time.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import pino, { type Logger } from "pino";

import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { decodeNimbusJsonCursorPayload } from "./nimbus-json-cursor.ts";
import { createRampSyncable } from "./ramp-sync.ts";

const TOKEN_URL = "https://api.ramp.com/developer/v1/token";
const TXNS_URL = "https://api.ramp.com/developer/v1/transactions?page_size=100";
const PAGE_2 = "https://api.ramp.com/developer/v1/transactions?page_size=100&start=t2";
const INCOMING = "nimbus-ramp1:incoming-cursor";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Each URL answers from its own queue, in order; an exhausted or unknown URL fails the test. */
function queuedFetch(routes: Record<string, Array<() => Response>>): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const next = routes[url]?.shift();
    if (next === undefined) throw new Error(`unexpected fetch ${url}`);
    return Promise.resolve(next());
  }) as typeof fetch;
  return calls;
}

const json =
  (body: unknown, status = 200) =>
  (): Response =>
    Response.json(body, { status });
const text =
  (body: string, status = 200) =>
  (): Response =>
    new Response(body, { status });

type LogLine = { level: number; msg: string };

function ctxFor(db: Database): {
  ctx: ReturnType<typeof syncTestContext>;
  warnings: () => string[];
} {
  const raw: string[] = [];
  const logger: Logger = pino({ level: "warn" }, { write: (s: string) => raw.push(s) });
  const ctx = {
    ...syncTestContext(
      db,
      createStubVault({ "ramp.client_id": "id", "ramp.client_secret": "secret" }),
      "ramp",
    ),
    logger,
  };
  return { ctx, warnings: () => raw.map((s) => (JSON.parse(s) as LogLine).msg) };
}

function sync(db: Database, cursor: string | null = INCOMING) {
  const { ctx, warnings } = ctxFor(db);
  return {
    run: createRampSyncable({ ensureRampMcpRunning: async () => {} }).sync(ctx, cursor),
    warnings,
  };
}

function isPass1(cursor: string | null): boolean {
  const p = decodeNimbusJsonCursorPayload(cursor ?? "", "nimbus-ramp1:") as
    | { pass?: unknown }
    | undefined;
  return p?.pass === 1;
}

describe("token exchange", () => {
  test("with no client id stored at all, the pass is a no-op that makes no request", async () => {
    const calls = queuedFetch({});
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "ramp.client_secret": "secret" }), "ramp");

    const r = await createRampSyncable({ ensureRampMcpRunning: async () => {} }).sync(
      ctx,
      INCOMING,
    );

    expect(calls).toEqual([]);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBe(INCOMING);
    db.close();
  });

  test("a token response that is not JSON is logged and ends the pass before any data request", async () => {
    const calls = queuedFetch({ [TOKEN_URL]: [text("<html>maintenance</html>")] });
    const db = createMemoryIndexDb();
    const { run, warnings } = sync(db);

    const r = await run;

    expect(calls).toEqual([TOKEN_URL]);
    expect(r.itemsUpserted).toBe(0);
    // A transport-class failure keeps the caller's cursor.
    expect(r.cursor).toBe(INCOMING);
    expect(warnings()).toContain("ramp token exchange returned invalid JSON");
    db.close();
  });

  test("a 401 whose re-exchange also fails keeps the caller's cursor and asks for nothing more", async () => {
    const calls = queuedFetch({
      [TOKEN_URL]: [json({ access_token: "first" }), text("down", 500)],
      [TXNS_URL]: [text("expired", 401)],
    });
    const db = createMemoryIndexDb();

    const r = await sync(db).run;

    expect(calls).toEqual([TOKEN_URL, TXNS_URL, TOKEN_URL]);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBe(INCOMING);
    db.close();
  });
});

describe("transaction pages", () => {
  test("a first page that is not JSON resets the cursor to pass 1", async () => {
    queuedFetch({
      [TOKEN_URL]: [json({ access_token: "t" })],
      [TXNS_URL]: [text("not json")],
    });
    const db = createMemoryIndexDb();

    const r = await sync(db).run;

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).not.toBe(INCOMING);
    expect(isPass1(r.cursor)).toBe(true);
    db.close();
  });

  test("a later page failing keeps the rows the earlier pages already indexed", async () => {
    const calls = queuedFetch({
      [TOKEN_URL]: [json({ access_token: "t" })],
      [TXNS_URL]: [json({ data: [{ id: "t1" }, { id: "t2" }], page: { next: PAGE_2 } })],
      [PAGE_2]: [text("server error", 500)],
    });
    const db = createMemoryIndexDb();

    const r = await sync(db).run;

    expect(calls).toEqual([TOKEN_URL, TXNS_URL, PAGE_2]);
    expect(r.itemsUpserted).toBe(2);
    expect(isPass1(r.cursor)).toBe(true);
    const ids = (
      db
        .query("SELECT external_id FROM item WHERE service = 'ramp' ORDER BY external_id")
        .all() as {
        external_id: string;
      }[]
    ).map((x) => x.external_id);
    expect(ids).toEqual(["t1", "t2"]);
    db.close();
  });

  test("a page whose data is not a list indexes nothing and ends the walk", async () => {
    queuedFetch({
      [TOKEN_URL]: [json({ access_token: "t" })],
      [TXNS_URL]: [json({ data: { id: "t1" }, page: {} })],
    });
    const db = createMemoryIndexDb();

    const r = await sync(db).run;

    expect(r.itemsUpserted).toBe(0);
    expect(isPass1(r.cursor)).toBe(true);
    db.close();
  });
});
