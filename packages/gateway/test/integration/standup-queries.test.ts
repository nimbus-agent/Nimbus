import { describe, expect, test } from "bun:test";
import {
  countMessageThreads,
  nonGithubMergedPrCount,
  selectActivePrs,
  selectIncidentsResponded,
  selectMergedPrs,
  selectMessages,
  selectPersonDisplayName,
  selectReviews,
  selectTicketsOpened,
} from "../../src/agents/standup-queries.ts";
import { createMemoryIndexDb } from "../../src/connectors/connector-sync-test-helpers.ts";

/**
 * Against the REAL migrated schema, not a hand-written one.
 *
 * Every lane here filters on `item.author_id` or joins `graph_relation`/`graph_entity`/`person`,
 * and the `index health` row's `raw_meta` precedent is the reason this is an integration test:
 * that arm cited a column of the LEGACY `items` table that has never existed on the live `item`
 * table, and unit tests over a hand-built schema would have agreed with it. A query naming a
 * column or a table that the migrations do not produce fails HERE and nowhere else.
 */
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** ABSOLUTE bounds. `sinceMs` as an agent INPUT is a duration repo-wide; `Window` is not an input. */
const W = { fromMs: NOW - DAY, toMs: NOW };
const ME = "person-me";
const OTHER = "person-other";

type Db = ReturnType<typeof createMemoryIndexDb>;

function insertItem(
  db: Db,
  row: {
    id: string;
    service: string;
    type: string;
    title: string;
    modifiedAt: number;
    authorId: string | null;
    meta?: unknown;
    externalId?: string;
  },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, author_id, metadata, synced_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    [
      row.id,
      row.service,
      row.type,
      row.externalId ?? row.id,
      row.title,
      row.modifiedAt,
      row.authorId,
      row.meta === undefined ? null : JSON.stringify(row.meta),
      NOW,
    ],
  );
}

function insertPerson(db: Db, id: string, displayName: string | null): void {
  db.run(`INSERT INTO person (id, display_name) VALUES (?, ?)`, [id, displayName]);
}

/**
 * A person → incident edge, built the way `graph-populator.ts` builds one: a `person` graph
 * entity whose `external_id` is the person id, an `incident` entity whose `external_id` is the
 * ITEM id, and a relation between them. Getting either `external_id` backwards is the mistake
 * this helper exists to make once rather than per test.
 */
function linkPersonToIncident(
  db: Db,
  opts: { personId: string; itemId: string; relation: "assigned" | "resolves" },
): void {
  const pe = `ge-person-${opts.personId}`;
  const ie = `ge-incident-${opts.itemId}`;
  // `graph_relation.type` carries a real FK to `graph_relation_type(name)`, so the type row has
  // to exist before the edge does — `graph-populator.ts` registers these at migration time.
  db.run(`INSERT OR IGNORE INTO graph_relation_type (name) VALUES (?)`, [opts.relation]);
  db.run(
    `INSERT OR IGNORE INTO graph_entity (id, type, external_id, label)
     VALUES (?, 'person', ?, ?)`,
    [pe, opts.personId, opts.personId],
  );
  db.run(
    `INSERT OR IGNORE INTO graph_entity (id, type, external_id, label)
     VALUES (?, 'incident', ?, ?)`,
    [ie, opts.itemId, opts.itemId],
  );
  // `graph_relation.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` — supplying a string id here
  // is what a hand-written schema would have accepted and the real one does not.
  db.run(`INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)`, [
    pe,
    ie,
    opts.relation,
    NOW,
  ]);
}

describe("standup queries against the real migrated schema", () => {
  test("active PRs: mine inside the window, not a colleague's and not one outside it", () => {
    const db = createMemoryIndexDb();
    try {
      insertItem(db, {
        id: "pr-mine",
        service: "github",
        type: "pr",
        title: "Mine, touched today",
        modifiedAt: NOW - HOUR,
        authorId: ME,
        meta: { state: "open" },
      });
      insertItem(db, {
        id: "pr-theirs",
        service: "github",
        type: "pr",
        title: "Someone else's",
        modifiedAt: NOW - HOUR,
        authorId: OTHER,
        meta: { state: "open" },
      });
      insertItem(db, {
        id: "pr-stale",
        service: "github",
        type: "pr",
        title: "Mine, untouched for a week",
        modifiedAt: NOW - 7 * DAY,
        authorId: ME,
        meta: { state: "open" },
      });
      const rows = selectActivePrs(db, W, ME);
      expect(rows.map((r) => r.id)).toEqual(["pr-mine"]);
      expect(rows[0]?.timeBasis).toBe("last_touch");
    } finally {
      db.close();
    }
  });

  test("active PRs exclude a merged one on EITHER merge signal, and on both forges", () => {
    const db = createMemoryIndexDb();
    try {
      // GitHub writes `merged_at`; GitLab/Bitbucket write neither, leaving `state`/`merged` as
      // the only evidence. Testing one signal would leave every merged MR in the active list.
      insertItem(db, {
        id: "pr-merged-at",
        service: "github",
        type: "pr",
        title: "Merged, has merged_at",
        modifiedAt: NOW - HOUR,
        authorId: ME,
        meta: { state: "closed", merged_at: NOW - 2 * HOUR },
      });
      insertItem(db, {
        id: "pr-state-merged",
        service: "gitlab",
        type: "pr",
        title: "Merged, state only",
        modifiedAt: NOW - HOUR,
        authorId: ME,
        meta: { state: "merged" },
      });
      insertItem(db, {
        id: "pr-merged-flag",
        service: "bitbucket",
        type: "pr",
        title: "Merged, boolean flag only",
        modifiedAt: NOW - HOUR,
        authorId: ME,
        meta: { merged: 1 },
      });
      insertItem(db, {
        id: "pr-open",
        service: "github",
        type: "pr",
        title: "Still open",
        modifiedAt: NOW - HOUR,
        authorId: ME,
        meta: { state: "open", merged: 0 },
      });
      expect(selectActivePrs(db, W, ME).map((r) => r.id)).toEqual(["pr-open"]);
    } finally {
      db.close();
    }
  });

  test("active PRs keep a row whose metadata is absent or unparseable", () => {
    const db = createMemoryIndexDb();
    try {
      // `json_valid(NULL)` is NULL, not 0, so a naive `json_valid(...) = 0` arm would drop this
      // row entirely — an unmerged PR of mine vanishing because its connector wrote no metadata.
      insertItem(db, {
        id: "pr-null-meta",
        service: "github",
        type: "pr",
        title: "No metadata at all",
        modifiedAt: NOW - HOUR,
        authorId: ME,
      });
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, url, modified_at, author_id, metadata, synced_at)
         VALUES ('pr-bad-meta', 'github', 'pr', 'pr-bad-meta', 'Broken metadata', NULL, ?, ?, 'not json', ?)`,
        [NOW - HOUR, ME, NOW],
      );
      expect(
        selectActivePrs(db, W, ME)
          .map((r) => r.id)
          .sort(),
      ).toEqual(["pr-bad-meta", "pr-null-meta"]);
    } finally {
      db.close();
    }
  });

  test("merged PRs window on metadata.merged_at, not on modified_at", () => {
    const db = createMemoryIndexDb();
    try {
      // The load-bearing case. This PR was MERGED eight days ago and TOUCHED an hour ago (a
      // comment bumps `modified_at`). A standup keyed on the column would report it as today's
      // work; keyed on the event field it is correctly absent.
      insertItem(db, {
        id: "pr-old-merge",
        service: "github",
        type: "pr",
        title: "Merged last week, commented today",
        modifiedAt: NOW - HOUR,
        authorId: ME,
        meta: { state: "closed", merged_at: NOW - 8 * DAY },
      });
      insertItem(db, {
        id: "pr-fresh-merge",
        service: "github",
        type: "pr",
        title: "Merged this morning",
        modifiedAt: NOW - 30 * 60_000,
        authorId: ME,
        meta: { state: "closed", merged_at: NOW - 3 * HOUR },
      });
      const rows = selectMergedPrs(db, W, ME);
      expect(rows.map((r) => r.id)).toEqual(["pr-fresh-merge"]);
      expect(rows[0]?.atMs).toBe(NOW - 3 * HOUR);
      expect(rows[0]?.timeBasis).toBe("event_field");
    } finally {
      db.close();
    }
  });

  test("merged PRs reject a STRING merged_at that SQLite would compare as in-window", () => {
    const db = createMemoryIndexDb();
    try {
      // SQLite orders every text value above every number, so `json_extract(...) >= fromMs`
      // passes for an ISO string and the row would be admitted with `atMs` set to a string.
      // The TypeScript re-check is the only thing that rejects it.
      insertItem(db, {
        id: "pr-string-merge",
        service: "github",
        type: "pr",
        title: "merged_at is an ISO string",
        modifiedAt: NOW - HOUR,
        authorId: ME,
        meta: { state: "closed", merged_at: "2026-09-11T00:00:00Z" },
      });
      expect(selectMergedPrs(db, W, ME)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("reviews come from the review ITEM and are event_column, not last_touch", () => {
    const db = createMemoryIndexDb();
    try {
      insertItem(db, {
        id: "rev-1",
        service: "github",
        type: "review",
        title: "Review on org/web#12",
        modifiedAt: NOW - 4 * HOUR,
        authorId: ME,
      });
      insertItem(db, {
        id: "rev-theirs",
        service: "github",
        type: "review",
        title: "Review by a colleague",
        modifiedAt: NOW - 4 * HOUR,
        authorId: OTHER,
      });
      const rows = selectReviews(db, W, ME);
      expect(rows.map((r) => r.id)).toEqual(["rev-1"]);
      expect(rows[0]?.timeBasis).toBe("event_column");
    } finally {
      db.close();
    }
  });

  test("tickets opened window on created_at_ms, written by BOTH ticket connectors", () => {
    const db = createMemoryIndexDb();
    try {
      // `jira-sync.ts` writes `created_at_ms` from `fields.created`; `linear-sync.ts` from
      // `createdAt`. Both are covered because a lane that worked for only one would report half
      // a day's tickets with nothing saying so.
      insertItem(db, {
        id: "JIRA-1",
        service: "jira",
        type: "issue",
        title: "Opened today (jira)",
        modifiedAt: NOW - 10 * HOUR,
        authorId: ME,
        meta: { created_at_ms: NOW - 5 * HOUR, status: "To Do" },
      });
      insertItem(db, {
        id: "LIN-1",
        service: "linear",
        type: "issue",
        title: "Opened today (linear)",
        modifiedAt: NOW - 10 * HOUR,
        authorId: ME,
        meta: { created_at_ms: NOW - 6 * HOUR },
      });
      insertItem(db, {
        id: "JIRA-OLD",
        service: "jira",
        type: "issue",
        title: "Opened a month ago, commented today",
        modifiedAt: NOW - HOUR,
        authorId: ME,
        meta: { created_at_ms: NOW - 30 * DAY },
      });
      const rows = selectTicketsOpened(db, W, ME);
      expect(rows.map((r) => r.id)).toEqual(["JIRA-1", "LIN-1"]);
      expect(rows.every((r) => r.timeBasis === "event_field")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("incidents: both edge types count, and one incident carrying both is listed ONCE", () => {
    const db = createMemoryIndexDb();
    try {
      insertItem(db, {
        id: "inc-both",
        service: "pagerduty",
        type: "incident",
        title: "Assigned to me and resolved by me",
        modifiedAt: NOW - 2 * HOUR,
        authorId: null,
        meta: { status: "resolved" },
      });
      insertItem(db, {
        id: "inc-assigned",
        service: "pagerduty",
        type: "incident",
        title: "Only assigned",
        modifiedAt: NOW - 3 * HOUR,
        authorId: null,
        meta: { status: "triggered" },
      });
      insertItem(db, {
        id: "inc-theirs",
        service: "pagerduty",
        type: "incident",
        title: "A colleague's",
        modifiedAt: NOW - 3 * HOUR,
        authorId: null,
        meta: { status: "resolved" },
      });
      linkPersonToIncident(db, {
        personId: ME,
        itemId: "inc-both",
        relation: "assigned",
      });
      linkPersonToIncident(db, {
        personId: ME,
        itemId: "inc-both",
        relation: "resolves",
      });
      linkPersonToIncident(db, {
        personId: ME,
        itemId: "inc-assigned",
        relation: "assigned",
      });
      linkPersonToIncident(db, {
        personId: OTHER,
        itemId: "inc-theirs",
        relation: "resolves",
      });

      const rows = selectIncidentsResponded(db, W, ME);
      // Newest first. `inc-both` must appear exactly once despite carrying two edges — without
      // the DISTINCT it is listed twice and every count downstream is inflated.
      expect(rows.map((r) => r.id)).toEqual(["inc-both", "inc-assigned"]);
      expect(rows.every((r) => r.timeBasis === "last_touch")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("Slack: messages are mine only, and threads count distinct conversations", () => {
    const db = createMemoryIndexDb();
    try {
      // Two replies in one thread plus one standalone post = 3 messages across 2 threads. A
      // message count alone would report three conversations where there were two.
      insertItem(db, {
        id: "msg-a",
        service: "slack",
        type: "message",
        externalId: "C1:100.1",
        title: "reply one",
        modifiedAt: NOW - 5 * HOUR,
        authorId: ME,
        meta: { channel: "C1", thread_ts: "99.0" },
      });
      insertItem(db, {
        id: "msg-b",
        service: "slack",
        type: "message",
        externalId: "C1:100.2",
        title: "reply two",
        modifiedAt: NOW - 4 * HOUR,
        authorId: ME,
        meta: { channel: "C1", thread_ts: "99.0" },
      });
      insertItem(db, {
        id: "msg-c",
        service: "slack",
        type: "message",
        externalId: "C2:200.1",
        title: "a standalone post",
        modifiedAt: NOW - 3 * HOUR,
        authorId: ME,
        meta: { channel: "C2", thread_ts: null },
      });
      insertItem(db, {
        id: "msg-theirs",
        service: "slack",
        type: "message",
        externalId: "C1:100.9",
        title: "not mine",
        modifiedAt: NOW - 3 * HOUR,
        authorId: OTHER,
        meta: { channel: "C1", thread_ts: "99.0" },
      });

      expect(selectMessages(db, W, ME).map((r) => r.id)).toEqual(["msg-c", "msg-b", "msg-a"]);
      expect(countMessageThreads(db, W, ME)).toBe(2);
    } finally {
      db.close();
    }
  });

  test("threads: two unthreaded messages are TWO threads, not one NULL bucket", () => {
    const db = createMemoryIndexDb();
    try {
      // Keying on `thread_ts` alone collapses every top-level message into a single bucket,
      // reporting "1 thread" for a day spent posting in five different channels.
      for (const [i, ch] of ["C1", "C2", "C3"].entries()) {
        insertItem(db, {
          id: `msg-${ch}`,
          service: "slack",
          type: "message",
          externalId: `${ch}:${String(300 + i)}.0`,
          title: `post in ${ch}`,
          modifiedAt: NOW - (i + 1) * HOUR,
          authorId: ME,
          meta: { channel: ch, thread_ts: null },
        });
      }
      expect(countMessageThreads(db, W, ME)).toBe(3);
    } finally {
      db.close();
    }
  });

  test("non-GitHub merged PRs are counted for the disclosure, and GitHub's are not", () => {
    const db = createMemoryIndexDb();
    try {
      insertItem(db, {
        id: "mr-gitlab",
        service: "gitlab",
        type: "pr",
        title: "Merged MR with no merge timestamp",
        modifiedAt: NOW - 2 * HOUR,
        authorId: ME,
        meta: { state: "merged" },
      });
      insertItem(db, {
        id: "pr-bitbucket",
        service: "bitbucket",
        type: "pr",
        title: "Merged via boolean flag",
        modifiedAt: NOW - 2 * HOUR,
        authorId: ME,
        meta: { merged: 1 },
      });
      insertItem(db, {
        id: "pr-github",
        service: "github",
        type: "pr",
        title: "GitHub merge — visible to the merged lane, so not counted here",
        modifiedAt: NOW - 2 * HOUR,
        authorId: ME,
        meta: { state: "merged", merged_at: NOW - 2 * HOUR },
      });
      insertItem(db, {
        id: "mr-theirs",
        service: "gitlab",
        type: "pr",
        title: "A colleague's merged MR",
        modifiedAt: NOW - 2 * HOUR,
        authorId: OTHER,
        meta: { state: "merged" },
      });
      expect(nonGithubMergedPrCount(db, W, ME)).toBe(2);
    } finally {
      db.close();
    }
  });

  test("display name: present, blank, and absent are three distinct answers", () => {
    const db = createMemoryIndexDb();
    try {
      insertPerson(db, ME, "Ada Lovelace");
      insertPerson(db, "person-blank", "   ");
      insertPerson(db, "person-null", null);
      expect(selectPersonDisplayName(db, ME)).toBe("Ada Lovelace");
      // A whitespace-only name renders as an empty inline-code span in the brief header, which
      // reads as a bug rather than as missing data — so it is normalised to absent.
      expect(selectPersonDisplayName(db, "person-blank")).toBeNull();
      expect(selectPersonDisplayName(db, "person-null")).toBeNull();
      // No row at all: reachable via `[user] mePersonId`, which is taken verbatim.
      expect(selectPersonDisplayName(db, "person-nonexistent")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("every lane returns empty for a person id nothing is attributed to", () => {
    const db = createMemoryIndexDb();
    try {
      insertItem(db, {
        id: "pr-theirs",
        service: "github",
        type: "pr",
        title: "Not mine",
        modifiedAt: NOW - HOUR,
        authorId: OTHER,
        meta: { state: "open" },
      });
      const ghost = "person-does-not-exist";
      expect(selectActivePrs(db, W, ghost)).toEqual([]);
      expect(selectMergedPrs(db, W, ghost)).toEqual([]);
      expect(selectReviews(db, W, ghost)).toEqual([]);
      expect(selectTicketsOpened(db, W, ghost)).toEqual([]);
      expect(selectIncidentsResponded(db, W, ghost)).toEqual([]);
      expect(selectMessages(db, W, ghost)).toEqual([]);
      expect(countMessageThreads(db, W, ghost)).toBe(0);
      expect(nonGithubMergedPrCount(db, W, ghost)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("the window is half-open: fromMs is included, toMs is not", () => {
    const db = createMemoryIndexDb();
    try {
      // Run daily over adjacent windows, an inclusive upper bound puts a boundary event in two
      // consecutive standups. `metrics/stats.ts` already records that as a known limit of the
      // inclusive form, which is why this follows it rather than `dora.ts`.
      insertItem(db, {
        id: "pr-at-from",
        service: "github",
        type: "pr",
        title: "Exactly at the lower bound",
        modifiedAt: W.fromMs,
        authorId: ME,
        meta: { state: "open" },
      });
      insertItem(db, {
        id: "pr-at-to",
        service: "github",
        type: "pr",
        title: "Exactly at the upper bound",
        modifiedAt: W.toMs,
        authorId: ME,
        meta: { state: "open" },
      });
      expect(selectActivePrs(db, W, ME).map((r) => r.id)).toEqual(["pr-at-from"]);
    } finally {
      db.close();
    }
  });
});
