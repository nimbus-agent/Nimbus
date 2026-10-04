/**
 * Issue-pass paths the Sentry suite does not reach, driven through the exported
 * `syncSentryIssuePass` directly:
 *  - a failed page that is NOT a 403 must be reported as a list failure, never as the
 *    `event:read` scope hint that is specific to a 403;
 *  - a 200 whose body is not JSON, and one that is JSON but not an array;
 *  - a `rel="next"` link that cannot be parsed as a URL;
 *  - an `apiRoot` that cannot be parsed, which must stop the walk rather than follow a link whose
 *    origin it can no longer verify (every follow carries the bearer token).
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { type SentryIssuePassInput, syncSentryIssuePass } from "./sentry-issue-sync.ts";

const API_ROOT = "https://sentry.example.test/api/0";
const ISSUES_RE = /^https:\/\/sentry\.example\.test\/api\/0\/organizations\/acme\/issues\//;
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const ISSUE = { id: "101", title: "TypeError: x is undefined", lastSeen: "2026-09-30T10:00:00Z" };
const SCOPE_HINT = "sentry sync: issues forbidden — the auth token needs the event:read scope";
const LIST_FAILED = "sentry sync: issues list failed";

let fetchStub: StubFetch;
let db: Database;
let logged: { msg: string; status?: number }[];

beforeEach(() => {
  fetchStub = new StubFetch();
  fetchStub.install();
  db = createMemoryIndexDb();
  logged = [];
});

afterEach(() => {
  fetchStub.restore();
  db.close();
});

function ctx(): SyncContext {
  const logger = pino(
    { level: "warn" },
    {
      write: (line: string) => {
        logged.push(JSON.parse(line) as { msg: string; status?: number });
      },
    },
  );
  return { ...syncTestContext(db, EMPTY_NIMBUS_VAULT, "sentry"), logger };
}

function input(over: Partial<SentryIssuePassInput> = {}): SentryIssuePassInput {
  return {
    ctx: ctx(),
    apiRoot: API_ROOT,
    org: "acme",
    token: "sntrys-test",
    sinceMs: NOW - 30 * 86_400_000,
    cursorLastSeenMs: null,
    now: NOW,
    maxPages: 5,
    resumeUrl: null,
    pendingMax: null,
    ...over,
  };
}

function issueIds(): string[] {
  return (
    db
      .query("SELECT external_id FROM item WHERE service = 'sentry' ORDER BY external_id")
      .all() as { external_id: string }[]
  ).map((r) => r.external_id);
}

describe("syncSentryIssuePass — failed pages", () => {
  test("a 500 is logged as a list failure, not as the 403-only event:read scope hint", async () => {
    fetchStub.respondWithText("GET", ISSUES_RE, "upstream exploded", { status: 500 });

    const res = await syncSentryIssuePass(input());

    expect(res).toEqual({
      upserted: 0,
      bytes: "upstream exploded".length,
      ok: false,
      runningMaxMs: null,
      resumeUrl: null,
      hasMore: false,
    });
    expect(logged.map((l) => l.msg)).toEqual([LIST_FAILED]);
    expect(logged[0]?.status).toBe(500);
  });

  test("control: a 403 is the case that names the event:read scope", async () => {
    fetchStub.respondWithText("GET", ISSUES_RE, "forbidden", { status: 403 });

    const res = await syncSentryIssuePass(input());

    expect(res.ok).toBe(false);
    expect(logged.map((l) => l.msg)).toEqual([SCOPE_HINT]);
  });
});

describe("syncSentryIssuePass — 200 bodies of the wrong shape", () => {
  test("a body that is not JSON fails the walk, indexing nothing", async () => {
    fetchStub.respondWithText("GET", ISSUES_RE, "<html>maintenance</html>");

    const res = await syncSentryIssuePass(input({ pendingMax: 42 }));

    expect(res).toEqual({
      upserted: 0,
      bytes: "<html>maintenance</html>".length,
      ok: false,
      runningMaxMs: 42,
      resumeUrl: null,
      hasMore: false,
    });
    expect(logged.map((l) => l.msg)).toEqual(["sentry sync: issues body not JSON"]);
    expect(issueIds()).toEqual([]);
  });

  test("a JSON body that is not an array indexes nothing but completes the walk", async () => {
    // A lone issue OBJECT, not an error body: it would map if anything treated a non-array body
    // as a one-entry list, so "indexes nothing" here proves the body was ignored, not unmappable.
    fetchStub.respond("GET", ISSUES_RE, ISSUE);

    const res = await syncSentryIssuePass(input());

    expect(res).toEqual({
      upserted: 0,
      bytes: JSON.stringify(ISSUE).length,
      ok: true,
      runningMaxMs: null,
      resumeUrl: null,
      hasMore: false,
    });
    expect(logged).toEqual([]);
    expect(issueIds()).toEqual([]);
  });
});

describe("syncSentryIssuePass — next links that cannot be followed safely", () => {
  test("a rel=next href that is not a parseable URL ends the walk like a last page", async () => {
    fetchStub.respond("GET", ISSUES_RE, [ISSUE], {
      headers: { Link: '<http://[bad>; rel="next"; results="true"; cursor="0:100:0"' },
    });

    const res = await syncSentryIssuePass(input());

    expect(fetchStub.calls).toHaveLength(1);
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(1);
    expect(res.resumeUrl).toBeNull();
    expect(res.hasMore).toBe(false);
    expect(res.runningMaxMs).toBe(Date.parse(ISSUE.lastSeen));
    expect(issueIds()).toEqual(["101"]);
  });

  test("an apiRoot that cannot be parsed refuses to follow even a same-host next link", async () => {
    const resumeUrl =
      "https://sentry.example.test/api/0/organizations/acme/issues/?cursor=0:100:0&limit=100";
    const nextUrl =
      "https://sentry.example.test/api/0/organizations/acme/issues/?cursor=0:200:0&limit=100";
    fetchStub.respond("GET", resumeUrl, [ISSUE], {
      headers: { Link: `<${nextUrl}>; rel="next"; results="true"; cursor="0:200:0"` },
    });
    // Routed so that following it would be observable as a second call, not a stub rejection.
    fetchStub.respond("GET", nextUrl, []);

    const res = await syncSentryIssuePass(
      input({ apiRoot: "sentry.example.test/api/0", resumeUrl, pendingMax: 5 }),
    );

    expect(fetchStub.calls.map((c) => c.url)).toEqual([resumeUrl]);
    expect(fetchStub.calls[0]?.headers["authorization"]).toBe("Bearer sntrys-test");
    expect(res.ok).toBe(true);
    expect(res.upserted).toBe(1);
    expect(res.resumeUrl).toBeNull();
    expect(res.hasMore).toBe(false);
    expect(res.runningMaxMs).toBe(Date.parse(ISSUE.lastSeen));
  });
});
