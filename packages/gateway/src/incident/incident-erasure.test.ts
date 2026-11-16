import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import {
  countPushedBriefsForErasure,
  deletePushedBriefsForErasure,
} from "../oncall-push/push-store.ts";
import { buildRecord } from "./__fixtures__/record-builder.ts";
import {
  eraseIncidentDataForService,
  previewIncidentErasure,
  pruneIncidentRecordsWithBriefs,
} from "./incident-erasure.ts";
import { upsertIncidentRecord } from "./incident-store.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

function record(
  d: Database,
  itemId: string,
  cited: string[],
  over: Parameters<typeof buildRecord>[0] & { sha?: string; now?: number } = {},
): void {
  const service = itemId.slice(0, itemId.indexOf(":")) as "pagerduty";
  upsertIncidentRecord(d, {
    record: buildRecord({ itemId, service, ...over }),
    markdown: "md",
    recordSha256: over.sha ?? "h1",
    citedServices: cited,
    nowMs: over.now ?? 5_000,
  });
}

function brief(d: Database, id: string, text = "brief"): void {
  d.run(
    `INSERT INTO pushed_brief (incident_id, status, brief_markdown, created_at) VALUES (?, 'ok', ?, 1)`,
    [id, text],
  );
}

const briefIds = (d: Database): string[] =>
  (d.query("SELECT incident_id AS id FROM pushed_brief ORDER BY id").all() as { id: string }[]).map(
    (r) => r.id,
  );

describe("eraseIncidentDataForService", () => {
  test("deletes the records citing the service (any version) and the briefs built from them; keeps the rest", () => {
    const d = db();
    record(d, "pagerduty:P1", ["pagerduty", "slack"], { sha: "a" });
    record(d, "pagerduty:P1", ["pagerduty"], { sha: "b" }); // version 2 no longer cites slack
    record(d, "pagerduty:P2", ["pagerduty"]);
    record(d, "jira:J1", ["jira"]);
    brief(d, "pagerduty:P1", "titles of Slack messages");
    brief(d, "pagerduty:P2");
    brief(d, "jira:J1");
    const preview = previewIncidentErasure(d, "slack");
    expect(preview).toEqual({ recordsDeleted: 1, pushedBriefsDeleted: 1 });
    expect(briefIds(d)).toHaveLength(3); // the preview deletes nothing
    const r = eraseIncidentDataForService(d, "slack");
    expect(r).toEqual({ recordsDeleted: 1, pushedBriefsDeleted: 1 });
    expect(briefIds(d)).toEqual(["jira:J1", "pagerduty:P2"]);
    expect(d.query("SELECT count(*) AS n FROM incident_record").get()).toEqual({ n: 2 });
    expect(d.query("SELECT count(*) AS n FROM incident_record_version").get()).toEqual({ n: 2 });
  });

  test("a PagerDuty erasure removes its own pushed briefs, with or without a record (the prefix arm)", () => {
    const d = db();
    record(d, "pagerduty:P1", ["pagerduty"]);
    record(d, "jira:J1", ["jira"]);
    brief(d, "pagerduty:P1");
    brief(d, "pagerduty:OLD-NO-RECORD"); // written by the old agents.oncall dispatch
    brief(d, "jira:J1");
    expect(eraseIncidentDataForService(d, "pagerduty")).toEqual({
      recordsDeleted: 1,
      pushedBriefsDeleted: 2,
    });
    expect(briefIds(d)).toEqual(["jira:J1"]);
  });

  test("a metacharacter in a service id is literal", () => {
    const d = db();
    record(d, "pagerduty:P1", ["pagerduty", "slack"]);
    brief(d, "slack:x");
    brief(d, "pagerduty:P1");
    eraseIncidentDataForService(d, "sl_ck");
    eraseIncidentDataForService(d, "sl%");
    expect(briefIds(d)).toEqual(["pagerduty:P1", "slack:x"]);
  });

  test("runs inside the caller's transaction: a failure after the record delete rolls everything back", () => {
    const d = db();
    record(d, "pagerduty:P1", ["pagerduty", "slack"]);
    brief(d, "pagerduty:P1");
    d.run(
      "CREATE TRIGGER boom BEFORE DELETE ON pushed_brief BEGIN SELECT RAISE(ABORT, 'forced'); END",
    );
    const outer = d.transaction(() => {
      eraseIncidentDataForService(d, "slack");
    });
    expect(() => outer()).toThrow("forced");
    expect(d.query("SELECT count(*) AS n FROM incident_record").get()).toEqual({ n: 1 });
    expect(d.query("SELECT count(*) AS n FROM incident_record_version").get()).toEqual({ n: 1 });
    expect(briefIds(d)).toEqual(["pagerduty:P1"]);
  });
});

describe("pruneIncidentRecordsWithBriefs", () => {
  test("deletes the pruned records' versions and briefs together; an unrelated brief survives", () => {
    const d = db();
    record(d, "pagerduty:old", ["pagerduty", "slack"], { openedAtMs: 100 });
    record(d, "pagerduty:new", ["pagerduty"], { openedAtMs: 9_000_000 });
    brief(d, "pagerduty:old", "Slack titles");
    brief(d, "pagerduty:new");
    expect(pruneIncidentRecordsWithBriefs(d, 1_000_000)).toEqual({ recordsDeleted: 1, batches: 1 });
    expect(briefIds(d)).toEqual(["pagerduty:new"]);
    // a later erasure of the cited connector finds no brief text anywhere
    expect(eraseIncidentDataForService(d, "slack")).toEqual({
      recordsDeleted: 0,
      pushedBriefsDeleted: 0,
    });
    expect(
      d.query("SELECT count(*) AS n FROM pushed_brief WHERE brief_markdown LIKE '%Slack%'").get(),
    ).toEqual({ n: 0 });
  });

  test("a forced failure in the brief delete leaves the record (one transaction per batch)", () => {
    const d = db();
    record(d, "pagerduty:old", ["pagerduty"], { openedAtMs: 100 });
    brief(d, "pagerduty:old");
    d.run(
      "CREATE TRIGGER boom BEFORE DELETE ON pushed_brief BEGIN SELECT RAISE(ABORT, 'forced'); END",
    );
    expect(() => pruneIncidentRecordsWithBriefs(d, 1_000_000)).toThrow("forced");
    expect(d.query("SELECT count(*) AS n FROM incident_record").get()).toEqual({ n: 1 });
    expect(briefIds(d)).toEqual(["pagerduty:old"]);
  });

  test("batches until a batch is not full", () => {
    const d = db();
    for (const n of [1, 2, 3, 4, 5])
      record(d, `pagerduty:P${String(n)}`, ["pagerduty"], { openedAtMs: 10 });
    expect(pruneIncidentRecordsWithBriefs(d, 1_000_000, 2)).toEqual({
      recordsDeleted: 5,
      batches: 3,
    });
    expect(pruneIncidentRecordsWithBriefs(d, 1_000_000, 2, 1)).toEqual({
      recordsDeleted: 0,
      batches: 1,
    });
  });
});

describe("deletePushedBriefsForErasure", () => {
  test("the JSON id array form, the empty list, and the prefix-only arm", () => {
    const d = db();
    for (const id of ["a:1", "a:2", "b:1", "it's:1", "%:1"]) brief(d, id);
    expect(deletePushedBriefsForErasure(d, { triggerItemIds: [] })).toBe(0);
    expect(deletePushedBriefsForErasure(d, { triggerItemIds: ["it's:1"] })).toBe(1);
    expect(countPushedBriefsForErasure(d, { triggerItemIds: [], service: "a" })).toBe(2);
    expect(deletePushedBriefsForErasure(d, { triggerItemIds: [], service: "a" })).toBe(2);
    expect(deletePushedBriefsForErasure(d, { triggerItemIds: [], service: "%" })).toBe(1);
    expect(briefIds(d)).toEqual(["b:1"]);
  });
});
