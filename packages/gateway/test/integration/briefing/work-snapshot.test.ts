/**
 * Morning briefing MB1, end to end over real SQLite: the three REAL syncables through the production
 * capability set (`syncTestContext` binds a service the way `sync/scheduler.ts` does), a fake HTTP
 * layer per provider. The first file of the directory MB5's acceptance test will use.
 *
 * The index is a real SQLite FILE in a fresh temp directory (so a test can close and reopen it), and
 * everything runs in this process: production syncables run inside the gateway and this path starts no
 * subprocess, so there is nothing a spawned gateway would add.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppleSyncable } from "../../../src/connectors/apple-sync.ts";
import {
  createStubVault,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { createGithubSyncable } from "../../../src/connectors/github-sync.ts";
import { createJiraSyncable } from "../../../src/connectors/jira-sync.ts";
import { createLinearSyncable } from "../../../src/connectors/linear-sync.ts";
import {
  decodeNimbusJsonCursorObject,
  encodeNimbusJsonCursor,
} from "../../../src/connectors/nimbus-json-cursor.ts";
import { createOutlookSyncable } from "../../../src/connectors/outlook-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ensureFullSqlite } from "../../../src/platform/sqlite-runtime.ts";
import {
  createOAuthConnectorTestSetup,
  requestUrlString,
} from "../../../src/testing/bun-test-support.ts";
import { rmDirWithRetry } from "../../helpers/rm-dir-with-retry.ts";

const tempDirs: string[] = [];

/** A real SQLite file index in a fresh temp directory; `reopen` opens the same file again. */
function createFileIndexDb(dir?: string): { db: Database; dir: string } {
  ensureFullSqlite();
  const root = dir ?? mkdtempSync(join(tmpdir(), "nimbus-work-snapshot-"));
  if (dir === undefined) tempDirs.push(root);
  const db = new Database(join(root, "index.db"));
  LocalIndex.ensureSchema(db);
  return { db, dir: root };
}

const createIndexDb = (): Database => createFileIndexDb().db;

const realFetch = globalThis.fetch;
let requests: string[] = [];
let router: (url: string, body: string) => Response = () => new Response("{}", { status: 404 });

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: { body?: unknown }) => {
    const url = requestUrlString(input);
    requests.push(url);
    return router(url, typeof init?.body === "string" ? init.body : "");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const d of tempDirs.splice(0)) rmDirWithRetry(d);
});

// Not an atlassian.net site: the MB3 on-call step then makes no request without a stored cloud id.
const JIRA_BASE = "https://jira.example.com";
const jiraVault = () =>
  createStubVault({
    "jira.email": "u@example.com",
    "jira.api_token": "tok",
    "jira.base_url": JIRA_BASE,
  });

function jiraIssue(key: string, due?: string): Record<string, unknown> {
  return {
    id: `id-${key}`,
    key,
    fields: {
      summary: key,
      updated: "2026-04-01T12:00:00.000+0000",
      ...(due ? { duedate: due } : {}),
    },
  };
}

function snapshotCount(db: Database, service: string): number {
  return (
    db.query("SELECT count(*) AS n FROM work_snapshot WHERE service = ?").get(service) as {
      n: number;
    }
  ).n;
}

function joinedCount(db: Database, service: string): number {
  return (
    db
      .query(
        "SELECT count(*) AS n FROM work_snapshot w JOIN item i ON i.id = w.item_id WHERE w.service = ?",
      )
      .get(service) as { n: number }
  ).n;
}

function jiraRouter(members: () => Array<Record<string, unknown>>, fail: () => boolean) {
  return (_url: string, body: string): Response => {
    const req = JSON.parse(body) as { jql: string };
    if (req.jql.startsWith("assignee = currentUser()")) {
      if (fail()) return new Response("boom", { status: 500 });
      const issues = members();
      return new Response(JSON.stringify({ issues, startAt: 0, total: issues.length }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ issues: [], startAt: 0, total: 0 }), { status: 200 });
  };
}

describe("work snapshots, end to end", () => {
  test("jira: snapshot rows resolve to items, a deleted item takes its row, a failed re-snapshot keeps the old rows", async () => {
    const db = createIndexDb();
    const ctx = syncTestContext(db, jiraVault(), "jira");
    let failing = false;
    router = jiraRouter(
      () => [jiraIssue("A-1", "2026-11-20"), jiraIssue("A-2")],
      () => failing,
    );
    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await sync.sync(ctx, null);
    expect(snapshotCount(db, "jira")).toBe(2);
    expect(joinedCount(db, "jira")).toBe(2);
    const capturedAt = (
      db.query("SELECT min(captured_at) AS c FROM work_snapshot").get() as { c: number }
    ).c;

    failing = true;
    await sync.sync(ctx, null);
    expect(snapshotCount(db, "jira")).toBe(2);
    expect(
      (db.query("SELECT min(captured_at) AS c FROM work_snapshot").get() as { c: number }).c,
    ).toBe(capturedAt);

    ctx.deleteItem("jira", "A-1");
    expect(snapshotCount(db, "jira")).toBe(1);
    expect(joinedCount(db, "jira")).toBe(1);
    db.close();
  });

  test("two services in one index never mix: a github replace leaves jira unchanged", async () => {
    const db = createIndexDb();
    const jiraCtx = syncTestContext(db, jiraVault(), "jira");
    router = jiraRouter(
      () => [jiraIssue("A-1")],
      () => false,
    );
    await createJiraSyncable({ ensureJiraMcpRunning: async () => {} }).sync(jiraCtx, null);
    const jiraBefore = db
      .query("SELECT item_id, captured_at FROM work_snapshot WHERE service = 'jira'")
      .all();

    const ghCtx = syncTestContext(db, createStubVault({ "github.pat": "pat" }), "github");
    router = (url) =>
      url.includes("/search/issues") && url.includes("assignee")
        ? new Response(
            JSON.stringify({
              total_count: 1,
              incomplete_results: false,
              items: [
                {
                  number: 7,
                  title: "t",
                  html_url: "https://github.com/o/r/issues/7",
                  state: "open",
                  repository_url: "https://api.github.com/repos/o/r",
                  user: { login: "me" },
                  updated_at: "2026-11-02T00:00:00Z",
                  milestone: { title: "m", due_on: "2026-11-20T00:00:00Z" },
                },
              ],
            }),
            { status: 200 },
          )
        : new Response("[]", { status: 200 });
    await createGithubSyncable({ ensureGithubMcpRunning: async () => {} }).sync(
      ghCtx,
      encodeNimbusJsonCursor("nimbus-ghub1:", { etag: null, login: "me" }),
    );
    expect(snapshotCount(db, "github")).toBe(1);
    expect(joinedCount(db, "github")).toBe(1);
    expect(
      db.query("SELECT item_id, captured_at FROM work_snapshot WHERE service = 'jira'").all(),
    ).toEqual(jiraBefore);
    db.close();
  });

  test("linear: the snapshot resolves to items", async () => {
    const db = createIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "linear.api_key": "key" }), "linear");
    router = (_url, body) => {
      const isSnap = (JSON.parse(body) as { query: string }).query.includes("viewer");
      const nodes = [
        { id: "u1", identifier: "ENG-1", title: "t", updatedAt: "2026-04-01T00:00:00.000Z" },
      ];
      return new Response(
        JSON.stringify({
          data: isSnap
            ? {
                viewer: {
                  assignedIssues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
                },
              }
            : { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
        { status: 200 },
      );
    };
    await createLinearSyncable({ ensureLinearMcpRunning: async () => {} }).sync(ctx, null);
    expect(joinedCount(db, "linear")).toBe(1);
    db.close();
  });

  test("the interval end to end: syncs inside it make one set of requests, one after it makes a second, no cursor makes one at once", async () => {
    const db = createIndexDb();
    const ctx = syncTestContext(db, jiraVault(), "jira");
    router = jiraRouter(
      () => [jiraIssue("A-1")],
      () => false,
    );
    const sync = createJiraSyncable({
      ensureJiraMcpRunning: async () => {},
      snapshotIntervalMinutes: () => 15,
    });
    const snapshotRequests = (): number => requests.length;
    let cursor: string | null = null;
    // three consecutive syncs: only the first (no cursor) takes a snapshot
    for (let i = 0; i < 3; i += 1) {
      cursor = (await sync.sync(ctx, cursor)).cursor;
    }
    // each sync is one incremental request; the first adds one snapshot request
    expect(snapshotRequests()).toBe(4);
    // a cursor whose last attempt is 16 minutes old takes a second snapshot
    const rec = decodeNimbusJsonCursorObject(cursor, "nimbus-jra1:");
    const aged = encodeNimbusJsonCursor("nimbus-jra1:", {
      v: 1,
      floorJql: rec?.["floorJql"] ?? null,
      snapAt: Date.now() - 16 * 60_000,
    });
    requests = [];
    await sync.sync(ctx, aged);
    expect(requests).toHaveLength(2);
    // what index.rebody leaves (a cleared cursor) snapshots immediately
    requests = [];
    await sync.sync(ctx, null);
    expect(requests).toHaveLength(2);
    db.close();
  });

  test("the cursor survives closing and reopening the index: snapAt is honoured and the snapshot rows stay", async () => {
    const first = createFileIndexDb();
    router = jiraRouter(
      () => [jiraIssue("A-1"), jiraIssue("A-2")],
      () => false,
    );
    const sync = createJiraSyncable({
      ensureJiraMcpRunning: async () => {},
      snapshotIntervalMinutes: () => 15,
    });
    const r1 = await sync.sync(syncTestContext(first.db, jiraVault(), "jira"), null);
    expect(snapshotCount(first.db, "jira")).toBe(2);
    const persisted = decodeNimbusJsonCursorObject(r1.cursor, "nimbus-jra1:");
    expect(typeof persisted?.["snapAt"]).toBe("number");
    const cursor = r1.cursor;
    first.db.close();

    const second = createFileIndexDb(first.dir);
    expect(snapshotCount(second.db, "jira")).toBe(2);
    requests = [];
    const r2 = await sync.sync(syncTestContext(second.db, jiraVault(), "jira"), cursor);
    // inside the interval: only the incremental request, no snapshot request, rows unchanged
    expect(requests).toHaveLength(1);
    expect(snapshotCount(second.db, "jira")).toBe(2);
    expect(decodeNimbusJsonCursorObject(r2.cursor, "nimbus-jra1:")?.["snapAt"]).toBe(
      persisted?.["snapAt"],
    );
    second.db.close();
  });

  test("outlook: a real delta page indexes is_read and an outl2 cursor is ignored", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "outlook");
    const sync = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });
    // Since MB2b the syncable also asks for the calendar; a message page read as events would
    // overwrite the mail row, so that request gets its own (empty) answer.
    router = (url) =>
      url.includes("/calendarView/")
        ? new Response(
            JSON.stringify({
              value: [],
              "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?t=1",
            }),
          )
        : new Response(
            JSON.stringify({
              value: [
                {
                  id: "m1",
                  subject: "s",
                  bodyPreview: "p",
                  receivedDateTime: "2026-11-01T08:00:00Z",
                  isRead: false,
                },
              ],
              "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/messages/delta?token=end",
            }),
            { status: 200 },
          );
    const stale = `nimbus-outl2:${Buffer.from(
      JSON.stringify({ v: 1, nextUrl: "https://graph.microsoft.com/v1.0/me/messages/delta?x=1" }),
    ).toString("base64url")}`;
    await sync.sync(ctx, stale);
    expect(requests[0]).toContain("/me/messages/delta?$top=");
    expect(decodeURIComponent(requests[0] ?? "")).toContain(",isRead");
    const row = db.query("SELECT metadata FROM item WHERE external_id = 'm1'").get() as {
      metadata: string;
    };
    expect(JSON.parse(row.metadata)).toMatchObject({ is_read: false, meta_v: 1 });
  });

  test("icloud: a TZID event through the real parse yields its start_ms", async () => {
    const db = createIndexDb();
    const vault = createStubVault({
      "apple.icloud_email": "me@icloud.com",
      "apple.icloud_app_password": "pw",
    });
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:e1",
      "SUMMARY:s",
      "DTSTART;TZID=Europe/London:20260701T093000",
      "DTEND;TZID=Europe/London:20260701T103000",
      "ATTENDEE;PARTSTAT=TENTATIVE:mailto:me@icloud.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const sync = createAppleSyncable({
      ensureAppleMcpRunning: async () => {},
      fetchMessages: async () => ({ ok: true, messages: [] }),
      fetchEvents: async () => ({ ok: true, events: [{ calendar: "Home", ics }] }),
    });
    await sync.sync(syncTestContext(db, vault, "apple"), null);
    const row = db.query("SELECT metadata FROM item WHERE external_id = 'e1'").get() as {
      metadata: string;
    };
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(meta["start_ms"]).toBe(Date.UTC(2026, 6, 1, 8, 30));
    expect(meta["self_response"]).toBe("tentative");
    db.close();
  });
});
