import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { mapJsmAlertToItem } from "../connectors/jsm-alert-mapping.ts";
import { upsertOncallShift } from "../connectors/oncall-shift-items.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { deleteItemByPrimaryKey } from "./item-store.ts";
import {
  HANDOFF_DEFAULT_WINDOW_MS,
  HANDOFF_LIST_CAP,
  HANDOFF_MAX_SHIFT_WINDOW_MS,
  type HandoffServiceBinding,
  queryOncallHandoff,
} from "./oncall-handoff-query.ts";
import { replaceWorkSnapshotRows } from "./work-snapshot-store.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const SVC = "PSVC1";
const OTHER = "PSVC2";
const iso = (ms: number): string => new Date(ms).toISOString();

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

const CHECKOUT: HandoffServiceBinding = {
  serviceId: "checkout",
  pagerdutyServices: [SVC],
  jsmAlertTags: ["checkout"],
  incidentWindowMinutes: 60,
};

type Pd = {
  id: string;
  status: "triggered" | "acknowledged" | "resolved";
  createdAt: number;
  changedAt?: number;
  service?: string;
};

/** Writes through the REAL PagerDuty writer, so the metadata keys are the ones a sync produces. */
function pd(d: Database, row: Pd, syncedAt: number): void {
  syncPagerdutyIncidentItems(
    syncTestContext(d, EMPTY_NIMBUS_VAULT, "pagerduty"),
    [
      {
        id: row.id,
        title: `Incident ${row.id}`,
        status: row.status,
        urgency: "high",
        created_at: iso(row.createdAt),
        updated_at: iso(syncedAt),
        ...(row.changedAt === undefined ? {} : { last_status_change_at: iso(row.changedAt) }),
        html_url: `https://pd.example/${row.id}`,
        service: { id: row.service ?? SVC },
        priority: { name: "P1" },
      },
    ],
    "",
    syncedAt,
    new Map(),
  );
}

/** Writes through the REAL JSM alert mapper. */
function alert(
  d: Database,
  a: { id: string; status: "open" | "closed"; createdAt: number; tags?: string[] },
  syncedAt: number,
): void {
  const row = mapJsmAlertToItem(
    {
      id: a.id,
      message: `Alert ${a.id}`,
      status: a.status,
      priority: "P2",
      acknowledged: false,
      createdAt: iso(a.createdAt),
      updatedAt: iso(syncedAt),
      tags: a.tags ?? [],
      ...(a.status === "closed" ? { report: { closeTime: 5 * 60_000 } } : {}),
    },
    { syncedAt },
  );
  if (row === null) throw new Error("alert did not map");
  syncTestContext(d, EMPTY_NIMBUS_VAULT, "jira").upsertItem(row);
}

function shift(d: Database, over: Record<string, unknown> = {}): void {
  upsertOncallShift(
    syncTestContext(d, EMPTY_NIMBUS_VAULT, "pagerduty"),
    {
      source: "pagerduty",
      userId: "U1",
      userName: "Alice Ng",
      userEmail: null,
      policyId: "EP1",
      policyName: "Payments policy",
      level: 1,
      scheduleId: "S1",
      scheduleName: "Payments primary",
      startMs: NOW - 5 * HOUR,
      endMs: NOW + 3 * HOUR,
      serviceIds: [SVC],
      serviceNames: ["checkout"],
      serviceMapComplete: true,
      isMe: true,
      url: null,
      ...over,
    } as Parameters<typeof upsertOncallShift>[1],
    NOW - 60_000,
  );
}

function deployment(d: Database, id: string, startedAtMs: number, serviceId = "checkout"): void {
  d.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, author_id, metadata, synced_at)
     VALUES (?, 'github_actions', 'ci_run', ?, ?, NULL, ?, NULL, NULL, ?)`,
    [id, id, `Deploy ${id}`, startedAtMs, NOW],
  );
  d.run(
    `INSERT INTO deployment_items
       (id, provider, nimbus_service_id, environment, sha, ref, started_at_ms, finished_at_ms,
        conclusion, workflow_url, ci_run_external_id, created_at)
     VALUES (?, 'github-actions', ?, 'prod', 'abc', 'refs/heads/main', ?, ?, 'success', NULL, NULL, ?)`,
    [id, serviceId, startedAtMs, startedAtMs + 60_000, NOW],
  );
}

function codes(r: { gaps: Array<{ code: string }> }): string[] {
  return r.gaps.map((g) => g.code);
}

describe("queryOncallHandoff: an empty index yields gaps, never 'nothing happened'", () => {
  test("every unanswerable section is named in the gaps", () => {
    const r = queryOncallHandoff(db(), { nowMs: NOW, zone: "UTC" });
    expect(r.status).toBe("ok");
    expect(r.events.total).toBe(0);
    expect(r.stillOpen.total).toBe(0);
    expect(r.window.basis).toBe("default");
    expect(r.window.fromMs).toBe(NOW - HANDOFF_DEFAULT_WINDOW_MS);
    expect(r.window.reason).toContain("no on-call shifts are indexed");
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        "no_incident_data",
        "no_history",
        "no_shift_data",
        "no_deployments_indexed",
        "work_snapshot_empty",
        "ended_shifts_not_indexed",
        "observation_time",
        "sources_covered",
      ]),
    );
  });
});

describe("queryOncallHandoff: events", () => {
  test("opened, acknowledged and resolved are listed in time order with their time basis", () => {
    const d = db();
    pd(d, { id: "A", status: "triggered", createdAt: NOW - 3 * HOUR }, NOW - 3 * HOUR);
    pd(d, { id: "A", status: "acknowledged", createdAt: NOW - 3 * HOUR }, NOW - 2 * HOUR);
    pd(
      d,
      { id: "A", status: "resolved", createdAt: NOW - 3 * HOUR, changedAt: NOW - HOUR },
      NOW - HOUR + 60_000,
    );
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    const kinds = r.events.items.map((e) => `${e.kind}:${e.key ?? ""}:${e.atBasis}`);
    expect(kinds).toEqual([
      "opened::provider",
      "state_changed:status:observed",
      "resolved:status:provider",
    ]);
    expect(r.events.items[1]).toMatchObject({ from: "triggered", to: "acknowledged" });
    // Resolved at the PROVIDER's time, not the later sync time.
    expect(r.events.items[2]?.atMs).toBe(NOW - HOUR);
    expect(r.stillOpen.total).toBe(0);
    // Three status writes in the window: the incident changed state more than once.
    expect(r.watch.flagged.items.map((w) => w.reason)).toEqual(["changed_state_repeatedly"]);
    // History began after the window start, and the brief says so.
    expect(codes(r)).toContain("history_begins_after_window_start");
    expect(codes(r)).not.toContain("no_incident_data");
  });

  test("an item first seen long after it opened is not an open during the window", () => {
    const d = db();
    pd(d, { id: "OLD", status: "triggered", createdAt: NOW - 40 * HOUR }, NOW - HOUR);
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.events.items.filter((e) => e.kind === "opened")).toEqual([]);
    expect(r.stillOpen.items.map((o) => o.itemId)).toEqual(["pagerduty:OLD"]);
  });

  test("a resolution with no history row is read from the provider's time", () => {
    const d = db();
    // Written by the real writer, then the history for it is removed: history begins at the upgrade.
    pd(
      d,
      { id: "R", status: "resolved", createdAt: NOW - 4 * HOUR, changedAt: NOW - 2 * HOUR },
      NOW - HOUR,
    );
    d.run("DELETE FROM item_history");
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.events.items.map((e) => e.kind)).toEqual(["opened", "resolved"]);
    expect(codes(r)).toContain("no_history");
  });

  test("a reopened incident goes on the watch-list", () => {
    const d = db();
    pd(
      d,
      { id: "RE", status: "resolved", createdAt: NOW - 8 * HOUR, changedAt: NOW - 7 * HOUR },
      NOW - 6 * HOUR,
    );
    pd(d, { id: "RE", status: "triggered", createdAt: NOW - 8 * HOUR }, NOW - 2 * HOUR);
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.watch.flagged.items[0]).toMatchObject({
      reason: "reopened",
      itemId: "pagerduty:RE",
    });
    expect(r.stillOpen.items.map((o) => o.itemId)).toEqual(["pagerduty:RE"]);
  });

  test("a JSM alert's open and close come through the real mapper", () => {
    const d = db();
    alert(d, { id: "AL1", status: "open", createdAt: NOW - 4 * HOUR }, NOW - 4 * HOUR);
    alert(d, { id: "AL1", status: "closed", createdAt: NOW - 4 * HOUR }, NOW - 2 * HOUR);
    alert(d, { id: "AL2", status: "open", createdAt: NOW - HOUR }, NOW - HOUR);
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.events.items.map((e) => `${e.source}:${e.kind}:${e.itemId}`)).toEqual([
      "jsm:opened:jira:AL1",
      "jsm:resolved:jira:AL1",
      "jsm:opened:jira:AL2",
    ]);
    expect(r.stillOpen.items.map((o) => o.itemId)).toEqual(["jira:AL2"]);
  });

  test("lists are capped, totals are not, and the cap is disclosed", () => {
    const d = db();
    for (let i = 0; i < HANDOFF_LIST_CAP + 5; i += 1) {
      pd(d, { id: `C${String(i)}`, status: "triggered", createdAt: NOW - HOUR + i }, NOW - HOUR);
    }
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.events.items).toHaveLength(HANDOFF_LIST_CAP);
    expect(r.events.total).toBe(HANDOFF_LIST_CAP + 5);
    expect(r.stillOpen.total).toBe(HANDOFF_LIST_CAP + 5);
    expect(codes(r)).toContain("lists_capped");
  });
});

describe("queryOncallHandoff: still open", () => {
  test("oldest first, with the end state of a window that ends in the past", () => {
    const d = db();
    pd(d, { id: "N", status: "triggered", createdAt: NOW - 2 * HOUR }, NOW - 2 * HOUR);
    pd(d, { id: "O", status: "triggered", createdAt: NOW - 6 * HOUR }, NOW - 6 * HOUR);
    pd(
      d,
      { id: "X", status: "resolved", createdAt: NOW - 6 * HOUR, changedAt: NOW - HOUR },
      NOW - HOUR,
    );
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.stillOpen.items.map((o) => o.itemId)).toEqual(["pagerduty:O", "pagerduty:N"]);
    // At NOW-3h, X was still open (it resolved at NOW-1h) and N had not opened.
    const past = queryOncallHandoff(d, {
      nowMs: NOW,
      sinceMs: NOW - 8 * HOUR,
      untilMs: NOW - 3 * HOUR,
      zone: "UTC",
    });
    expect(past.window.basis).toBe("explicit");
    expect(past.stillOpen.items.map((o) => o.itemId)).toEqual(["pagerduty:O", "pagerduty:X"]);
    expect(codes(past)).toContain("window_ends_in_past");
  });

  test("a resolved item with no resolution time is counted as unknown, not shown as open", () => {
    const d = db();
    pd(d, { id: "U", status: "resolved", createdAt: NOW - 6 * HOUR }, NOW - 5 * HOUR);
    const r = queryOncallHandoff(d, {
      nowMs: NOW,
      sinceMs: NOW - 8 * HOUR,
      untilMs: NOW - 3 * HOUR,
      zone: "UTC",
    });
    expect(r.stillOpen.total).toBe(0);
    expect(codes(r)).toContain("end_state_unknown");
  });
});

describe("queryOncallHandoff: the window", () => {
  test("follows the owner's current shift when the index holds one", () => {
    const d = db();
    shift(d);
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.window).toMatchObject({ basis: "own_shift", fromMs: NOW - 5 * HOUR, toMs: NOW });
    expect(r.window.reason).toContain("current on-call shift began");
    expect(r.shift.mine).toHaveLength(1);
    expect(r.shift.onCallNow[0]?.userName).toBe("Alice Ng");
  });

  test("a shift older than the limit is capped, and the reason says so", () => {
    const d = db();
    shift(d, { startMs: NOW - 30 * 86_400_000 });
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.window.fromMs).toBe(NOW - HANDOFF_MAX_SHIFT_WINDOW_MS);
    expect(r.window.reason).toContain("limit");
  });

  test("a shift that is not marked as the owner's falls back to 12 hours and says why", () => {
    const d = db();
    shift(d, { isMe: false });
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.window.basis).toBe("default");
    expect(r.window.reason).toContain("no indexed shift is marked as yours");
    expect(codes(r)).toContain("no_own_shift");
  });

  test("a Jira Service Management shift has no start, so it cannot set the window", () => {
    const d = db();
    shift(d, {
      source: "jsm",
      startMs: null,
      endMs: null,
      shift: "current",
    });
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.window.basis).toBe("default");
    expect(r.window.reason).toContain("no start time");
    expect(codes(r)).toContain("jsm_shift_untimed");
  });

  test("--since alone ends now; --until alone looks 12 hours back", () => {
    const d = db();
    const since = queryOncallHandoff(d, { nowMs: NOW, sinceMs: NOW - 2 * HOUR, zone: "UTC" });
    expect(since.window).toMatchObject({ basis: "explicit", toMs: NOW });
    const until = queryOncallHandoff(d, { nowMs: NOW, untilMs: NOW - HOUR, zone: "UTC" });
    expect(until.window.fromMs).toBe(NOW - HOUR - HANDOFF_DEFAULT_WINDOW_MS);
    expect(until.window.reason).toContain("--until");
  });
});

describe("queryOncallHandoff: service filter", () => {
  test("keeps only the service's incidents and alerts; an unknown service is no_match", () => {
    const d = db();
    pd(d, { id: "IN", status: "triggered", createdAt: NOW - HOUR }, NOW - HOUR);
    pd(d, { id: "OUT", status: "triggered", createdAt: NOW - HOUR, service: OTHER }, NOW - HOUR);
    alert(
      d,
      { id: "TAGGED", status: "open", createdAt: NOW - HOUR, tags: ["Checkout"] },
      NOW - HOUR,
    );
    alert(d, { id: "UNTAGGED", status: "open", createdAt: NOW - HOUR }, NOW - HOUR);
    const r = queryOncallHandoff(d, {
      nowMs: NOW,
      service: "checkout",
      serviceConfigs: [CHECKOUT],
      zone: "UTC",
    });
    expect(r.stillOpen.items.map((o) => o.itemId).sort()).toEqual(["jira:TAGGED", "pagerduty:IN"]);

    const byPd = queryOncallHandoff(d, {
      nowMs: NOW,
      service: SVC,
      serviceConfigs: [CHECKOUT],
      zone: "UTC",
    });
    expect(byPd.status).toBe("ok");

    const none = queryOncallHandoff(d, {
      nowMs: NOW,
      service: "nope",
      serviceConfigs: [CHECKOUT],
      zone: "UTC",
    });
    expect(none.status).toBe("no_match");
    expect(none.known).toEqual(["checkout"]);
  });
});

describe("queryOncallHandoff: deployments and the watch-list", () => {
  test("a deployment followed by an incident of the same service is flagged; others are not", () => {
    const d = db();
    deployment(d, "dep-bad", NOW - 3 * HOUR);
    deployment(d, "dep-fine", NOW - 6 * HOUR);
    deployment(d, "dep-other", NOW - 3 * HOUR, "payments");
    pd(
      d,
      { id: "AFTER", status: "triggered", createdAt: NOW - 3 * HOUR + 20 * 60_000 },
      NOW - HOUR,
    );
    pd(
      d,
      {
        id: "UNRELATED",
        status: "triggered",
        createdAt: NOW - 3 * HOUR + 20 * 60_000,
        service: OTHER,
      },
      NOW - HOUR,
    );
    const r = queryOncallHandoff(d, { nowMs: NOW, serviceConfigs: [CHECKOUT], zone: "UTC" });
    expect(r.deployments.total).toBe(3);
    expect(r.watch.deploysWithIncidents.items).toHaveLength(1);
    const hit = r.watch.deploysWithIncidents.items[0];
    expect(hit?.deployment.id).toBe("dep-bad");
    expect(hit?.items.map((i) => [i.itemId, i.stillOpen])).toEqual([["pagerduty:AFTER", true]]);
  });

  test("deployments with no service bindings are listed, and the missing check is disclosed", () => {
    const d = db();
    deployment(d, "dep-1", NOW - HOUR);
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.deployments.total).toBe(1);
    expect(codes(r)).toContain("no_service_bindings");
    expect(codes(r)).not.toContain("no_deployments_indexed");
  });

  test("assigned work due within 24 hours of the window end, overdue included", () => {
    const d = db();
    const jira = syncTestContext(d, EMPTY_NIMBUS_VAULT, "jira");
    const put = (key: string, dueIso: string): void => {
      jira.upsertItem({
        service: "jira",
        type: "issue",
        externalId: key,
        title: `Ticket ${key}`,
        body: "",
        url: null,
        canonicalUrl: null,
        modifiedAt: NOW,
        authorId: null,
        metadata: { key, due_at_ms: Date.parse(dueIso) },
        pinned: false,
        syncedAt: NOW,
      });
    };
    put("T-1", "2027-01-15T00:00:00Z"); // date-only due today -> ends 2027-01-16 00:00 UTC: due soon
    put("T-2", "2027-01-14T00:00:00Z"); // ended 2027-01-15 00:00 UTC: overdue
    put("T-3", "2027-01-20T00:00:00Z"); // later
    replaceWorkSnapshotRows(d, "jira", "assigned", ["T-1", "T-2", "T-3"], NOW);
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.watch.due.items.map((x) => [x.title, x.overdue])).toEqual([
      ["Ticket T-2", true],
      ["Ticket T-1", false],
    ]);
    expect(codes(r)).not.toContain("work_snapshot_empty");
  });
});

describe("queryOncallHandoff: edge cases", () => {
  test("an incident with no provider open time is opened at its observation, and sorts last when open", () => {
    const d = db();
    syncPagerdutyIncidentItems(
      syncTestContext(d, EMPTY_NIMBUS_VAULT, "pagerduty"),
      [{ id: "NOTIME", title: "No time", status: "triggered", service: { id: SVC } }],
      "",
      NOW - HOUR,
      new Map(),
    );
    pd(d, { id: "TIMED", status: "triggered", createdAt: NOW - 20 * HOUR }, NOW - 2 * HOUR);
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.events.items.map((e) => [e.itemId, e.kind, e.atBasis])).toEqual([
      ["pagerduty:NOTIME", "opened", "observed"],
    ]);
    expect(r.stillOpen.items.map((o) => o.itemId)).toEqual(["pagerduty:TIMED", "pagerduty:NOTIME"]);
  });

  test("an item removed upstream is listed by id, and a service filter drops history it cannot place", () => {
    const d = db();
    pd(d, { id: "GONE", status: "triggered", createdAt: NOW - 3 * HOUR }, NOW - 3 * HOUR);
    deleteItemByPrimaryKey(d, "pagerduty:GONE", NOW - HOUR);
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    const removed = r.events.items.find((e) => e.kind === "removed");
    expect(removed).toMatchObject({ itemId: "pagerduty:GONE", title: "pagerduty:GONE" });
    const scoped = queryOncallHandoff(d, {
      nowMs: NOW,
      service: "checkout",
      serviceConfigs: [CHECKOUT],
      zone: "UTC",
    });
    expect(scoped.events.items).toEqual([]);
  });

  test("severity and urgency changes are state changes; resolver noise is not", () => {
    const d = db();
    pd(d, { id: "S", status: "triggered", createdAt: NOW - 3 * HOUR }, NOW - 3 * HOUR);
    syncPagerdutyIncidentItems(
      syncTestContext(d, EMPTY_NIMBUS_VAULT, "pagerduty"),
      [
        {
          id: "S",
          title: "Incident S",
          status: "triggered",
          urgency: "low",
          created_at: iso(NOW - 3 * HOUR),
          service: { id: SVC },
          priority: { name: "P1" },
        },
      ],
      "",
      NOW - HOUR,
      new Map(),
    );
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.events.items.filter((e) => e.kind === "state_changed").map((e) => e.key)).toEqual([
      "urgency",
    ]);
  });

  test("a row with unreadable metadata is skipped, not a throw", () => {
    const d = db();
    d.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
       VALUES ('pagerduty:BAD', 'pagerduty', 'incident', 'BAD', 't', 1, 1, 'not json')`,
    );
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.stillOpen.total).toBe(0);
    expect(codes(r)).toContain("no_incident_data");
  });

  test("work without a due date, or an item that vanished from the index, is skipped", () => {
    const d = db();
    const jira = syncTestContext(d, EMPTY_NIMBUS_VAULT, "jira");
    jira.upsertItem({
      service: "jira",
      type: "issue",
      externalId: "T-9",
      title: "No due",
      body: "",
      url: null,
      canonicalUrl: null,
      modifiedAt: NOW,
      authorId: null,
      metadata: { key: "T-9" },
      pinned: false,
      syncedAt: NOW,
    });
    replaceWorkSnapshotRows(d, "jira", "assigned", ["T-9"], NOW);
    const r = queryOncallHandoff(d, { nowMs: NOW, zone: "UTC" });
    expect(r.watch.due.total).toBe(0);
    expect(codes(r)).not.toContain("work_snapshot_empty");
    const past = queryOncallHandoff(d, { nowMs: NOW, untilMs: NOW - 2 * HOUR, zone: "UTC" });
    expect(codes(past)).toContain("work_snapshot_current");
  });

  test("a service lookup the shift reader cannot match still shows the owner's own shift", () => {
    const d = db();
    shift(d);
    const r = queryOncallHandoff(d, {
      nowMs: NOW,
      service: "checkout",
      serviceConfigs: [{ ...CHECKOUT, pagerdutyServices: [SVC] }],
      zone: "UTC",
    });
    expect(r.shift.mine).toHaveLength(1);
    const other = queryOncallHandoff(d, {
      nowMs: NOW,
      service: "OTHERSVC",
      serviceConfigs: [{ ...CHECKOUT, serviceId: "OTHERSVC", pagerdutyServices: ["PX"] }],
      zone: "UTC",
    });
    expect(other.status).toBe("ok");
    expect(other.shift.mine).toHaveLength(1);
    expect(other.window.basis).toBe("own_shift");
  });
});
