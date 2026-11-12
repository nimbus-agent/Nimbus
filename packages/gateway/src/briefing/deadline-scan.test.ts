import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { seedItem, setSnapshot } from "../testing/briefing-fixtures.ts";
import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import { type BriefingStore, createBriefingStore } from "./briefing-store.ts";
import {
  DEADLINE_CANDIDATE_SQL,
  type DeadlineScanDeps,
  pruneDeadlineNotices,
  scanDeadlines,
} from "./deadline-scan.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 12, 9);
const CFG = { leadHours: 24, quietHours: 24 };

let db: Database;
let store: BriefingStore;
let toasts: Array<{ title: string; body: string }>;
let assigned: Record<string, string[]>;

beforeEach(() => {
  db = openMemoryIndexDatabase();
  store = createBriefingStore(db);
  toasts = [];
  assigned = { github: [], jira: [], linear: [] };
});
afterEach(() => db.close());

function deps(nowMs: number, over: Partial<DeadlineScanDeps> = {}): DeadlineScanDeps {
  return {
    db,
    store,
    nowMs,
    tz: "UTC",
    cfg: CFG,
    toast: async (title, body) => {
      toasts.push({ title, body });
      return "delivered";
    },
    ...over,
  };
}

function snapshotAll(): void {
  for (const [svc, ids] of Object.entries(assigned)) setSnapshot(db, svc, "assigned", ids, T0);
}

/** Seeds (or re-seeds) a GitHub issue and puts it in the `assigned` snapshot. */
function ghIssue(n: number, dueAt: number | null, modifiedAt = T0 - 30 * HOUR, state = "open") {
  const ext = `o/r#${String(n)}`;
  seedItem(db, {
    service: "github",
    type: "issue",
    externalId: ext,
    title: `SECRET TITLE ${String(n)}`,
    modifiedAt,
    metadata: { state, ...(dueAt === null ? {} : { due_at_ms: dueAt }) },
  });
  if (!assigned["github"]?.includes(ext)) assigned["github"]?.push(ext);
  snapshotAll();
}

describe("scanDeadlines", () => {
  test("exactly once: ten scans 15 minutes apart give one toast and one notice", async () => {
    ghIssue(1, T0 + 23 * HOUR);
    for (let i = 0; i < 10; i++) await scanDeadlines(deps(T0 + i * 15 * 60_000));
    expect(toasts).toEqual([
      { title: "Nimbus deadlines", body: "1 open item due within 24 h with no recent activity" },
    ]);
    expect(db.query("SELECT count(*) AS n FROM deadline_notice").get()).toEqual({ n: 1 });
  });

  test("the quiet-hours edge: recent activity suppresses, going quiet later notices then", async () => {
    ghIssue(1, T0 + 23 * HOUR, T0 - 2 * HOUR);
    expect((await scanDeadlines(deps(T0))).noticed).toBe(0);
    expect(toasts).toHaveLength(0);
    // 23 h later the edit is 25 h old (quiet over) and the due date is still ahead.
    ghIssue(1, T0 + 40 * HOUR, T0 - 2 * HOUR);
    expect((await scanDeadlines(deps(T0 + 23 * HOUR + 60_000))).noticed).toBe(1);
  });

  test("the window edges: 25 h out nothing, 24 h exactly notices, past nothing, no due nothing", async () => {
    ghIssue(1, T0 + 25 * HOUR);
    ghIssue(2, T0 + 24 * HOUR);
    ghIssue(3, T0 - 1);
    ghIssue(4, null);
    const r = await scanDeadlines(deps(T0));
    expect(r.candidates).toBe(1);
    expect(r.noticed).toBe(1);
  });

  test("a moved due date re-notifies only by an hour or more; a re-render of the same date does not", async () => {
    ghIssue(1, T0 + 20 * HOUR);
    await scanDeadlines(deps(T0));
    const id = (db.query("SELECT item_id FROM deadline_notice").get() as { item_id: string })
      .item_id;
    ghIssue(1, T0 + 20 * HOUR + 59 * 60_000);
    expect((await scanDeadlines(deps(T0 + 15 * 60_000))).noticed).toBe(0);
    expect(toasts).toHaveLength(1);
    expect(store.getNotice(id)?.dueAtMs).toBe(T0 + 20 * HOUR);
    ghIssue(1, T0 + 21 * HOUR);
    expect((await scanDeadlines(deps(T0 + 30 * 60_000))).noticed).toBe(1);
    expect(toasts).toHaveLength(2);
    expect(store.getNotice(id)?.dueAtMs).toBe(T0 + 21 * HOUR);
    expect(store.getNotice(id)?.notifiedAt).toBe(T0 + 30 * 60_000);
  });

  test("a Jira date-only due date is judged by the end of that date in the briefing zone", async () => {
    const la = "America/Los_Angeles";
    seedItem(db, {
      service: "jira",
      type: "issue",
      externalId: "J-1",
      title: "t",
      modifiedAt: T0 - 48 * HOUR,
      metadata: { status_category: "todo", due_at_ms: Date.parse("2026-11-13") },
    });
    assigned["jira"]?.push("J-1");
    snapshotAll();
    // The 13th ends at 2026-11-14 08:00Z in Los Angeles (PST). From 07:00Z on the 13th that is 25 h away.
    expect((await scanDeadlines(deps(Date.UTC(2026, 10, 13, 7), { tz: la }))).noticed).toBe(0);
    // From 09:00Z on the 13th it is 23 h away: notice (the UTC midnight is already past).
    expect((await scanDeadlines(deps(Date.UTC(2026, 10, 13, 9), { tz: la }))).noticed).toBe(1);
  });

  test("done, canceled and closed never notice; an unknown category does", async () => {
    const mk = (svc: "jira" | "linear", id: string, category: string) => {
      seedItem(db, {
        service: svc,
        type: "issue",
        externalId: id,
        title: "t",
        modifiedAt: T0 - 48 * HOUR,
        metadata: { status_category: category, due_at_ms: Date.parse("2026-11-12") },
      });
      assigned[svc]?.push(id);
    };
    mk("jira", "J-done", "done");
    mk("linear", "L-cancel", "canceled");
    mk("jira", "J-unknown", "unknown");
    ghIssue(7, T0 + HOUR, T0 - 48 * HOUR, "closed");
    // 2026-11-12 18:00Z: the 12th ends at 2026-11-13 00:00Z, six hours away.
    const r = await scanDeadlines(deps(Date.UTC(2026, 10, 12, 18)));
    expect(r.noticed).toBe(1);
  });

  test("several items give ONE toast; zero candidates give none", async () => {
    for (const n of [1, 2, 3]) ghIssue(n, T0 + 5 * HOUR);
    const r = await scanDeadlines(deps(T0));
    expect(r.noticed).toBe(3);
    expect(toasts).toEqual([
      { title: "Nimbus deadlines", body: "3 open items due within 24 h with no recent activity" },
    ]);
    const again = await scanDeadlines(deps(T0 + HOUR));
    expect(again).toEqual({ candidates: 3, noticed: 0, outcome: null });
    expect(toasts).toHaveLength(1);
  });

  test("a failing insert drops that item only; a failing toast keeps the written notices", async () => {
    ghIssue(1, T0 + 5 * HOUR);
    ghIssue(2, T0 + 5 * HOUR);
    const errors: unknown[] = [];
    let calls = 0;
    const flaky: BriefingStore = {
      ...store,
      insertNotice: (n) => {
        calls += 1;
        if (calls === 1) throw new Error("disk");
        store.insertNotice(n);
      },
    };
    const r = await scanDeadlines(deps(T0, { store: flaky, onError: (e) => errors.push(e) }));
    expect(r.candidates).toBe(2);
    expect(r.noticed).toBe(1);
    expect(errors).toHaveLength(1);
    expect(toasts[0]?.body).toContain("1 open item");

    const failing = await scanDeadlines(
      deps(T0 + 60_000, {
        store: flaky,
        toast: async () => {
          throw new Error("no toast");
        },
        onError: (e) => errors.push(e),
      }),
    );
    expect(failing.outcome).toBe("failed");
    expect(errors).toHaveLength(2);
    expect(db.query("SELECT count(*) AS n FROM deadline_notice").get()).toEqual({ n: 2 });
  });

  test("a failing toast with no error sink is swallowed", async () => {
    ghIssue(1, T0 + 5 * HOUR);
    const r = await scanDeadlines(
      deps(T0, {
        toast: async () => {
          throw new Error("no toast");
        },
      }),
    );
    expect(r.outcome).toBe("failed");
  });

  test("unreadable metadata is not a candidate", async () => {
    ghIssue(1, T0 + 5 * HOUR);
    db.run("UPDATE item SET metadata = '{bad'");
    expect((await scanDeadlines(deps(T0))).candidates).toBe(0);
    db.run("UPDATE item SET metadata = '[1]'");
    expect((await scanDeadlines(deps(T0))).candidates).toBe(0);
    db.run("UPDATE item SET metadata = NULL");
    expect((await scanDeadlines(deps(T0))).candidates).toBe(0);
  });

  test("deleting a noticed item removes its notice, so a recreated item notices again", async () => {
    ghIssue(1, T0 + 5 * HOUR);
    await scanDeadlines(deps(T0));
    db.run("DELETE FROM item WHERE external_id = 'o/r#1'");
    expect(db.query("SELECT count(*) AS n FROM deadline_notice").get()).toEqual({ n: 0 });
    ghIssue(1, T0 + 5 * HOUR);
    expect((await scanDeadlines(deps(T0 + 60_000))).noticed).toBe(1);
  });

  test("privacy: the candidate SQL names no title and no toast holds an item field", async () => {
    expect(DEADLINE_CANDIDATE_SQL.toLowerCase()).not.toContain("title");
    ghIssue(1, T0 + 5 * HOUR);
    await scanDeadlines(deps(T0));
    expect(JSON.stringify(toasts)).not.toContain("SECRET");
  });

  test("prune: a notice with a due date 31 days past is deleted, 29 days kept", () => {
    store.insertNotice({ itemId: "old", dueAtMs: T0 - 31 * 24 * HOUR, notifiedAt: 1 });
    store.insertNotice({ itemId: "recent", dueAtMs: T0 - 29 * 24 * HOUR, notifiedAt: 1 });
    expect(pruneDeadlineNotices(store, T0)).toBe(1);
    expect(store.getNotice("old")).toBeNull();
    expect(store.getNotice("recent")).not.toBeNull();
  });
});
