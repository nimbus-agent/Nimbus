import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import {
  readPagerdutySyncFreshness,
  selectActiveAssignedIncidents,
  selectActiveIncidentsForPagerdutyServices,
  selectChangeForDeployment,
  selectCiRunForDeployment,
  selectIncidentById,
  selectLastDeploymentBefore,
  selectPriorIncidents,
  selectServiceMessages,
} from "./oncall-queries.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ME = "person-me";
const PD_SVC = "PSERVICE1";

/**
 * The REAL migrated schema, never a hand-written `CREATE TABLE item`.
 *
 * Three of these lanes JOIN tables a hand-written `item`-only schema would not have —
 * `graph_entity`/`graph_relation` for assignment, `deployment_items` for the deploy lane, and
 * `item_fts` for chatter — so on a fake schema the "empty index yields nothing" tests would pass
 * as caught SQLite errors and prove nothing. `index health`'s roadmap row records exactly this
 * failure: a query written against the LEGACY `items` table's columns would have thrown at
 * runtime while its unit tests stayed green.
 */
function db(): Database {
  return createMemoryIndexDb();
}

function insertItem(
  d: Database,
  row: {
    id: string;
    type: string;
    service?: string;
    title?: string;
    body?: string | null;
    url?: string | null;
    modifiedAt?: number;
    authorId?: string | null;
    meta?: unknown;
  },
): void {
  d.run(
    `INSERT INTO item (id, service, type, external_id, title, body, url, modified_at, author_id, metadata, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.service ?? "pagerduty",
      row.type,
      row.id,
      row.title ?? row.id,
      row.body ?? null,
      row.url ?? null,
      row.modifiedAt ?? NOW - HOUR,
      row.authorId === undefined ? null : row.authorId,
      row.meta === undefined ? null : JSON.stringify(row.meta),
      NOW,
    ],
  );
}

function insertIncident(
  d: Database,
  row: {
    id: string;
    title?: string;
    status?: string;
    openedAtMs?: number;
    pdService?: string;
    severity?: string;
    urgency?: string;
    assignees?: string[];
    resolvedBy?: string | null;
    modifiedAt?: number;
  },
): void {
  insertItem(d, {
    id: row.id,
    type: "incident",
    service: "pagerduty",
    title: row.title ?? row.id,
    modifiedAt: row.modifiedAt ?? NOW - HOUR,
    meta: {
      status: row.status ?? "triggered",
      incidentId: row.id,
      assignee_emails: row.assignees ?? [],
      resolved_by_email: row.resolvedBy ?? null,
      unattributed_actors: [],
      meta_v: 1,
      opened_at_ms: row.openedAtMs ?? NOW - 2 * HOUR,
      pagerduty_service_id: row.pdService ?? PD_SVC,
      ...(row.severity === undefined ? {} : { severity: row.severity }),
      ...(row.urgency === undefined ? {} : { urgency: row.urgency }),
    },
  });
}

/** Wire a person to an incident the way `graph-populator.ts` does, via an `assigned` edge. */
function assign(d: Database, personId: string, incidentItemId: string, type = "assigned"): void {
  d.run(
    `INSERT OR IGNORE INTO graph_entity (id, type, external_id, label) VALUES (?, 'person', ?, ?)`,
    [`p:${personId}`, personId, personId],
  );
  d.run(
    `INSERT OR IGNORE INTO graph_entity (id, type, external_id, label) VALUES (?, 'incident', ?, ?)`,
    [`i:${incidentItemId}`, incidentItemId, incidentItemId],
  );
  d.run(`INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES (?, 1)`, [type]);
  d.run(
    `INSERT OR IGNORE INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)`,
    [`p:${personId}`, `i:${incidentItemId}`, type, NOW],
  );
}

function insertDeployment(
  d: Database,
  row: {
    id: string;
    serviceId?: string;
    environment?: string;
    sha?: string;
    startedAtMs: number;
    conclusion?: string;
    ciRunExternalId?: string | null;
  },
): void {
  insertItem(d, {
    id: row.id,
    type: "ci_run",
    service: "github_actions",
    title: `Deploy ${row.id}`,
  });
  d.run(
    `INSERT INTO deployment_items
       (id, provider, nimbus_service_id, environment, sha, ref, started_at_ms, finished_at_ms,
        conclusion, workflow_url, ci_run_external_id, created_at)
     VALUES (?, 'github-actions', ?, ?, ?, 'refs/heads/main', ?, ?, ?, NULL, ?, ?)`,
    [
      row.id,
      row.serviceId ?? "checkout",
      row.environment ?? "prod",
      row.sha ?? "sha-default",
      row.startedAtMs,
      row.startedAtMs + 60_000,
      row.conclusion ?? "success",
      row.ciRunExternalId === undefined ? null : row.ciRunExternalId,
      NOW,
    ],
  );
}

describe("selectActiveAssignedIncidents", () => {
  let d: Database;
  beforeEach(() => {
    d = db();
  });

  test("an empty index yields no incidents rather than an error", () => {
    expect(selectActiveAssignedIncidents(d, ME)).toEqual([]);
  });

  test("returns triggered and acknowledged incidents assigned to the person", () => {
    insertIncident(d, { id: "inc-1", status: "triggered" });
    insertIncident(d, { id: "inc-2", status: "acknowledged" });
    assign(d, ME, "inc-1");
    assign(d, ME, "inc-2");
    const got = selectActiveAssignedIncidents(d, ME);
    expect(got.map((i) => i.id).sort()).toEqual(["inc-1", "inc-2"]);
  });

  test("excludes resolved incidents — that is what ACTIVE means", () => {
    insertIncident(d, { id: "inc-open", status: "triggered" });
    insertIncident(d, { id: "inc-done", status: "resolved" });
    assign(d, ME, "inc-open");
    assign(d, ME, "inc-done");
    expect(selectActiveAssignedIncidents(d, ME).map((i) => i.id)).toEqual(["inc-open"]);
  });

  test("excludes incidents assigned to somebody else", () => {
    insertIncident(d, { id: "inc-theirs" });
    assign(d, "person-other", "inc-theirs");
    expect(selectActiveAssignedIncidents(d, ME)).toEqual([]);
  });

  test("newest by opened_at_ms first, so the auto-pick is the most recent", () => {
    insertIncident(d, { id: "inc-old", openedAtMs: NOW - 5 * HOUR });
    insertIncident(d, { id: "inc-new", openedAtMs: NOW - 1 * HOUR });
    assign(d, ME, "inc-old");
    assign(d, ME, "inc-new");
    expect(selectActiveAssignedIncidents(d, ME).map((i) => i.id)).toEqual(["inc-new", "inc-old"]);
  });

  test("a `resolves` edge counts as assignment, matching standup's incident lane", () => {
    insertIncident(d, { id: "inc-r" });
    assign(d, ME, "inc-r", "resolves");
    expect(selectActiveAssignedIncidents(d, ME).map((i) => i.id)).toEqual(["inc-r"]);
  });

  test("carries severity, urgency and assignees through", () => {
    insertIncident(d, {
      id: "inc-meta",
      severity: "P1",
      urgency: "high",
      assignees: ["ada@example.com"],
    });
    assign(d, ME, "inc-meta");
    const got = selectActiveAssignedIncidents(d, ME)[0];
    expect(got?.severity).toBe("P1");
    expect(got?.urgency).toBe("high");
    expect(got?.assigneeEmails).toEqual(["ada@example.com"]);
  });

  test("an incident whose metadata is malformed JSON is skipped, not thrown on", () => {
    insertItem(d, { id: "inc-bad", type: "incident", service: "pagerduty" });
    d.run(`UPDATE item SET metadata = '{not json' WHERE id = 'inc-bad'`);
    assign(d, ME, "inc-bad");
    expect(selectActiveAssignedIncidents(d, ME)).toEqual([]);
  });

  test("a missing status is treated as ACTIVE, because absent is not resolved", () => {
    insertItem(d, {
      id: "inc-nostatus",
      type: "incident",
      service: "pagerduty",
      meta: { incidentId: "inc-nostatus", assignee_emails: [], opened_at_ms: NOW - HOUR },
    });
    assign(d, ME, "inc-nostatus");
    expect(selectActiveAssignedIncidents(d, ME).map((i) => i.id)).toEqual(["inc-nostatus"]);
  });
});

describe("selectIncidentById", () => {
  test("returns null for an id that is not an incident", () => {
    const d = db();
    insertItem(d, { id: "pr-1", type: "pr", service: "github" });
    expect(selectIncidentById(d, "pr-1")).toBeNull();
    expect(selectIncidentById(d, "nope")).toBeNull();
  });

  test("returns a resolved incident too — an explicit id is not filtered by status", () => {
    const d = db();
    insertIncident(d, { id: "inc-done", status: "resolved" });
    expect(selectIncidentById(d, "inc-done")?.status).toBe("resolved");
  });
});

describe("selectActiveIncidentsForPagerdutyServices", () => {
  test("scopes by pagerduty service id and excludes resolved", () => {
    const d = db();
    insertIncident(d, { id: "inc-mine", pdService: "PA" });
    insertIncident(d, { id: "inc-other", pdService: "PB" });
    insertIncident(d, { id: "inc-done", pdService: "PA", status: "resolved" });
    expect(selectActiveIncidentsForPagerdutyServices(d, ["PA"]).map((i) => i.id)).toEqual([
      "inc-mine",
    ]);
  });

  test("an empty service list matches nothing rather than everything", () => {
    const d = db();
    insertIncident(d, { id: "inc-1" });
    expect(selectActiveIncidentsForPagerdutyServices(d, [])).toEqual([]);
  });
});

describe("readPagerdutySyncFreshness", () => {
  test("no sync_state row at all is `no_sync_record`", () => {
    const got = readPagerdutySyncFreshness(db(), NOW);
    expect(got).toEqual({ lastSyncMs: null, ageMs: null, reason: "no_sync_record" });
  });

  test("a row with a NULL last_sync_at is `never_synced`, which is a different fix", () => {
    const d = db();
    d.run(`INSERT INTO sync_state (connector_id, last_sync_at) VALUES ('pagerduty', NULL)`);
    expect(readPagerdutySyncFreshness(d, NOW).reason).toBe("never_synced");
  });

  test("a real sync time yields an age and no reason", () => {
    const d = db();
    d.run(`INSERT INTO sync_state (connector_id, last_sync_at) VALUES ('pagerduty', ?)`, [
      NOW - 2 * HOUR,
    ]);
    expect(readPagerdutySyncFreshness(d, NOW)).toEqual({
      lastSyncMs: NOW - 2 * HOUR,
      ageMs: 2 * HOUR,
      reason: null,
    });
  });
});

describe("selectLastDeploymentBefore", () => {
  test("picks the newest deploy that started STRICTLY before the incident opened", () => {
    const d = db();
    insertDeployment(d, { id: "dep-old", startedAtMs: NOW - 5 * HOUR });
    insertDeployment(d, { id: "dep-near", startedAtMs: NOW - 3 * HOUR });
    insertDeployment(d, { id: "dep-after", startedAtMs: NOW - 1 * HOUR });
    const got = selectLastDeploymentBefore(d, "checkout", ["prod"], NOW - 2 * HOUR);
    expect(got?.id).toBe("dep-near");
  });

  test("a deploy that started at the exact open instant does not count as BEFORE", () => {
    const d = db();
    insertDeployment(d, { id: "dep-exact", startedAtMs: NOW - 2 * HOUR });
    expect(selectLastDeploymentBefore(d, "checkout", ["prod"], NOW - 2 * HOUR)).toBeNull();
  });

  test("scopes to the service and the configured environments", () => {
    const d = db();
    insertDeployment(d, { id: "dep-other-svc", serviceId: "billing", startedAtMs: NOW - 3 * HOUR });
    insertDeployment(d, { id: "dep-staging", environment: "staging", startedAtMs: NOW - 3 * HOUR });
    expect(selectLastDeploymentBefore(d, "checkout", ["prod"], NOW)).toBeNull();
  });

  test("returns null when nothing precedes the incident", () => {
    expect(selectLastDeploymentBefore(db(), "checkout", ["prod"], NOW)).toBeNull();
  });
});

describe("selectChangeForDeployment", () => {
  test("matches the PR whose merge_commit_sha is the deployed sha", () => {
    const d = db();
    insertItem(d, {
      id: "pr-42",
      type: "pr",
      service: "github",
      title: "Fix checkout timeout",
      meta: {
        merged: true,
        merged_at: NOW - 4 * HOUR,
        merge_commit_sha: "abc123",
        additions: 12,
        deletions: 3,
        changed_files: 2,
      },
    });
    const got = selectChangeForDeployment(d, "abc123", ["github"]);
    expect(got?.id).toBe("pr-42");
    expect(got?.additions).toBe(12);
    expect(got?.changedFiles).toBe(2);
  });

  test("a PR on a forge that writes no merge_commit_sha cannot be matched", () => {
    const d = db();
    insertItem(d, {
      id: "mr-7",
      type: "pr",
      service: "gitlab",
      meta: { merged: true, state: "merged" },
    });
    expect(selectChangeForDeployment(d, "abc123", ["gitlab"])).toBeNull();
  });

  test("returns null when the sha matches nothing", () => {
    expect(selectChangeForDeployment(db(), "nosuchsha", ["github"])).toBeNull();
  });
});

describe("selectCiRunForDeployment", () => {
  test("resolves the ci_run item by its external id", () => {
    const d = db();
    insertItem(d, {
      id: "run-9",
      type: "ci_run",
      service: "github_actions",
      title: "Deploy prod",
      meta: { conclusion: "failure" },
    });
    const got = selectCiRunForDeployment(d, "run-9");
    expect(got?.id).toBe("run-9");
    expect(got?.conclusion).toBe("failure");
  });

  test("a null external id yields null rather than an unscoped query", () => {
    expect(selectCiRunForDeployment(db(), null)).toBeNull();
  });
});

describe("selectServiceMessages", () => {
  test("matches chat messages naming the service inside the window", () => {
    const d = db();
    insertItem(d, {
      id: "msg-1",
      type: "message",
      service: "slack",
      title: "checkout is throwing 500s",
      body: "checkout is throwing 500s",
      modifiedAt: NOW - HOUR,
    });
    insertItem(d, {
      id: "msg-2",
      type: "message",
      service: "slack",
      title: "lunch?",
      body: "lunch?",
      modifiedAt: NOW - HOUR,
    });
    const got = selectServiceMessages(d, { fromMs: NOW - DAY, toMs: NOW }, "checkout");
    expect(got.map((m) => m.id)).toEqual(["msg-1"]);
  });

  test("excludes messages outside the window", () => {
    const d = db();
    insertItem(d, {
      id: "msg-old",
      type: "message",
      service: "slack",
      title: "checkout was down",
      body: "checkout was down",
      modifiedAt: NOW - 3 * DAY,
    });
    expect(selectServiceMessages(d, { fromMs: NOW - DAY, toMs: NOW }, "checkout")).toEqual([]);
  });

  test("a service name with FTS syntax in it does not blow up the query", () => {
    const d = db();
    insertItem(d, { id: "msg-1", type: "message", service: "slack", title: "hi", body: "hi" });
    expect(() =>
      selectServiceMessages(d, { fromMs: NOW - DAY, toMs: NOW }, 'checkout OR "x'),
    ).not.toThrow();
  });

  test("an empty service name matches nothing rather than everything", () => {
    const d = db();
    insertItem(d, { id: "msg-1", type: "message", service: "slack", title: "hi", body: "hi" });
    expect(selectServiceMessages(d, { fromMs: NOW - DAY, toMs: NOW }, "")).toEqual([]);
  });
});

describe("selectPriorIncidents", () => {
  test("returns earlier incidents on the same pagerduty service, excluding the current one", () => {
    const d = db();
    insertIncident(d, { id: "inc-now", openedAtMs: NOW - HOUR });
    insertIncident(d, { id: "inc-prev", openedAtMs: NOW - 10 * DAY, status: "resolved" });
    insertIncident(d, { id: "inc-elsewhere", pdService: "PB", openedAtMs: NOW - 10 * DAY });
    const got = selectPriorIncidents(d, PD_SVC, NOW - HOUR, "inc-now", 10);
    expect(got.map((i) => i.id)).toEqual(["inc-prev"]);
  });

  test("carries who resolved it and when — never HOW, which is not indexed", () => {
    const d = db();
    insertIncident(d, {
      id: "inc-prev",
      openedAtMs: NOW - 10 * DAY,
      status: "resolved",
      resolvedBy: "ada@example.com",
      modifiedAt: NOW - 9 * DAY,
    });
    const got = selectPriorIncidents(d, PD_SVC, NOW, "inc-now", 10)[0];
    expect(got?.resolvedByEmail).toBe("ada@example.com");
    expect(got?.resolvedAtMs).toBe(NOW - 9 * DAY);
  });

  test("an unresolved prior incident has no resolution time", () => {
    const d = db();
    insertIncident(d, { id: "inc-prev", openedAtMs: NOW - 10 * DAY, status: "triggered" });
    const got = selectPriorIncidents(d, PD_SVC, NOW, "inc-now", 10)[0];
    expect(got?.resolvedAtMs).toBeNull();
  });

  test("honours the limit and returns newest first", () => {
    const d = db();
    for (let i = 0; i < 5; i++) {
      insertIncident(d, { id: `inc-${String(i)}`, openedAtMs: NOW - (i + 2) * DAY });
    }
    const got = selectPriorIncidents(d, PD_SVC, NOW, "inc-none", 3);
    expect(got.map((i) => i.id)).toEqual(["inc-0", "inc-1", "inc-2"]);
  });
});

describe("guard branches that a happy-path test never reaches", () => {
  test("selectChangeForDeployment: an empty sha or no PR services matches nothing", () => {
    const d = db();
    expect(selectChangeForDeployment(d, "", ["github"])).toBeNull();
    // No configured repos means no PR service columns to scope by — the unbound-service case.
    expect(selectChangeForDeployment(d, "abc123", [])).toBeNull();
  });

  test("selectChangeForDeployment: a matched PR with malformed metadata is null, not partial", () => {
    const d = db();
    insertItem(d, {
      id: "pr-bad",
      type: "pr",
      service: "github",
      meta: { merge_commit_sha: "s1" },
    });
    // `json_extract` matched, so SQL returned the row; the TypeScript re-read must still guard.
    d.run(`UPDATE item SET metadata = '[1,2]' WHERE id = 'pr-bad'`);
    expect(selectChangeForDeployment(d, "s1", ["github"])).toBeNull();
  });

  test("selectChangeForDeployment: absent diffstat fields read as null, never zero", () => {
    // `+0 −0 across 0 files` is a legitimate value for an empty-commit deploy, so "not recorded"
    // and "zero" must stay distinguishable all the way to the renderer.
    const d = db();
    insertItem(d, {
      id: "pr-nostat",
      type: "pr",
      service: "github",
      meta: { merge_commit_sha: "s2", merged: true },
    });
    const got = selectChangeForDeployment(d, "s2", ["github"]);
    expect(got?.additions).toBeNull();
    expect(got?.deletions).toBeNull();
    expect(got?.changedFiles).toBeNull();
    expect(got?.mergedAtMs).toBeNull();
  });

  test("selectCiRunForDeployment: an empty external id yields null", () => {
    expect(selectCiRunForDeployment(db(), "")).toBeNull();
  });

  test("selectCiRunForDeployment: a run with no metadata has a null conclusion, not a throw", () => {
    const d = db();
    insertItem(d, { id: "run-nometa", type: "ci_run", service: "github_actions" });
    expect(selectCiRunForDeployment(d, "run-nometa")?.conclusion).toBeNull();
  });

  test("selectLastDeploymentBefore: no configured environments matches nothing", () => {
    // An empty `IN ()` is a SQL error in most engines and an accident in the rest; the honest
    // answer for a service with no environments configured is "none".
    const d = db();
    insertDeployment(d, { id: "dep-1", startedAtMs: NOW - 3 * HOUR });
    expect(selectLastDeploymentBefore(d, "checkout", [], NOW)).toBeNull();
  });

  test("selectPriorIncidents: a non-positive limit returns nothing rather than everything", () => {
    const d = db();
    insertIncident(d, { id: "inc-prev", openedAtMs: NOW - 10 * DAY });
    expect(selectPriorIncidents(d, PD_SVC, NOW, "inc-now", 0)).toEqual([]);
    expect(selectPriorIncidents(d, "", NOW, "inc-now", 10)).toEqual([]);
  });

  test("selectPriorIncidents: an incident with NO open time is excluded, not admitted", () => {
    // "Prior" is the entire claim this lane makes; a row that cannot be placed in time cannot
    // support it. Excluded rather than sorted to the end.
    const d = db();
    insertItem(d, {
      id: "inc-notime",
      type: "incident",
      service: "pagerduty",
      meta: { incidentId: "inc-notime", assignee_emails: [], pagerduty_service_id: PD_SVC },
    });
    expect(selectPriorIncidents(d, PD_SVC, NOW, "inc-now", 10)).toEqual([]);
  });

  test("selectPriorIncidents: a STRING opened_at_ms is rejected by the TypeScript re-read", () => {
    // SQLite orders every text value above every number, so a date string would pass any bound
    // comparison made in SQL. `finiteNumberField` is what stops it.
    const d = db();
    insertItem(d, {
      id: "inc-strtime",
      type: "incident",
      service: "pagerduty",
      meta: {
        incidentId: "inc-strtime",
        assignee_emails: [],
        pagerduty_service_id: PD_SVC,
        opened_at_ms: "2026-09-11T00:00:00Z",
      },
    });
    expect(selectPriorIncidents(d, PD_SVC, NOW, "inc-now", 10)).toEqual([]);
  });

  test("readPagerdutySyncFreshness: a non-finite last_sync_at is `never_synced`", () => {
    const d = db();
    d.run(`INSERT INTO sync_state (connector_id, last_sync_at) VALUES ('pagerduty', NULL)`);
    expect(readPagerdutySyncFreshness(d, NOW).ageMs).toBeNull();
  });

  test("readPagerdutySyncFreshness: a future sync time clamps to zero, never a negative age", () => {
    // A clock step or a machine running ahead would otherwise render as "synced in -3 minutes"
    // in a brief someone reads under pressure.
    const d = db();
    d.run(`INSERT INTO sync_state (connector_id, last_sync_at) VALUES ('pagerduty', ?)`, [
      NOW + HOUR,
    ]);
    expect(readPagerdutySyncFreshness(d, NOW).ageMs).toBe(0);
  });

  test("selectActiveAssignedIncidents: an incident with no open time sorts LAST, not first", () => {
    // Auto-selection takes the first element, so a row we know least about must never outrank one
    // carrying a real open time.
    const d = db();
    insertIncident(d, { id: "inc-timed", openedAtMs: NOW - 9 * HOUR });
    insertItem(d, {
      id: "inc-untimed",
      type: "incident",
      service: "pagerduty",
      meta: { incidentId: "inc-untimed", assignee_emails: [], pagerduty_service_id: PD_SVC },
    });
    assign(d, ME, "inc-timed");
    assign(d, ME, "inc-untimed");
    expect(selectActiveAssignedIncidents(d, ME).map((i) => i.id)).toEqual([
      "inc-timed",
      "inc-untimed",
    ]);
  });

  test("selectIncidentById: malformed metadata yields null rather than a half-built incident", () => {
    const d = db();
    insertItem(d, { id: "inc-bad2", type: "incident", service: "pagerduty" });
    d.run(`UPDATE item SET metadata = 'nope' WHERE id = 'inc-bad2'`);
    expect(selectIncidentById(d, "inc-bad2")).toBeNull();
  });

  test("selectServiceMessages: a whitespace-only service name matches nothing", () => {
    const d = db();
    insertItem(d, { id: "msg-1", type: "message", service: "slack", title: "hi", body: "hi" });
    expect(selectServiceMessages(d, { fromMs: NOW - DAY, toMs: NOW }, "   ")).toEqual([]);
  });
});
