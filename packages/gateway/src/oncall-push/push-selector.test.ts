import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { selectActiveAssignedIncidents } from "../agents/oncall-queries.ts";
import { DEFAULT_ONCALL_PUSH_CONFIG } from "../config/oncall-push-toml.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { findPersonByCanonicalEmail } from "../people/person-store.ts";
import { ENABLE_GRACE_MS, resolveSeveritySet, selectPushCandidates } from "./push-selector.ts";

const ME = "me@acme.example";
const OTHER = "other@acme.example";
const T0 = Date.parse("2026-10-02T12:00:00.000Z");

type Inc = {
  id: string;
  status?: string;
  priority?: string;
  createdAt?: string | null;
  assignee?: string;
};
function pdRow(i: Inc): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: i.id,
    status: i.status ?? "triggered",
    title: `incident ${i.id}`,
    urgency: "high",
    updated_at: new Date(T0).toISOString(),
    service: { id: "PSVC" },
    assignments: [
      { assignee: { id: `U-${i.assignee ?? ME}`, type: "user", email: i.assignee ?? ME } },
    ],
  };
  if (i.priority !== undefined) row["priority"] = { name: i.priority };
  if (i.createdAt !== null) row["created_at"] = i.createdAt ?? new Date(T0).toISOString();
  return row;
}

let db: Database;
function seed(incidents: Inc[]): string {
  const ctx = syncTestContext(db, createStubVault({ "pagerduty.api_token": "tok" }), "pagerduty");
  syncPagerdutyIncidentItems(
    ctx,
    incidents.map(pdRow),
    new Date(T0 - 86_400_000).toISOString(),
    T0,
    new Map(),
  );
  const me = findPersonByCanonicalEmail(db, ME);
  if (me === null) throw new Error("fixture: the writer did not create the assignee person");
  return me.id;
}
beforeEach(() => {
  db = createMemoryIndexDb();
});
afterEach(() => db.close());

const P1 = resolveSeveritySet(DEFAULT_ONCALL_PUSH_CONFIG, []);
const base = (personId: string) => ({
  personId,
  severities: P1,
  enabledAtMs: T0 - 60_000,
  alreadyPushed: () => false,
});

describe("resolveSeveritySet", () => {
  test("default is {p1} ∪ aliases", () => {
    expect([...resolveSeveritySet(DEFAULT_ONCALL_PUSH_CONFIG, ["sev-1"])].sort()).toEqual([
      "p1",
      "sev-1",
    ]);
  });
  test("configured severities REPLACE the default", () => {
    expect([
      ...resolveSeveritySet({ ...DEFAULT_ONCALL_PUSH_CONFIG, severities: ["p2"] }, ["sev-1"]),
    ]).toEqual(["p2"]);
  });
});

describe("selectPushCandidates", () => {
  test("selects a triggered P1 assigned to me — and matches case-insensitively (P1 vs p1)", () => {
    const me = seed([{ id: "PA", priority: "P1" }]);
    expect(selectPushCandidates(db, base(me)).map((i) => i.id)).toEqual(["pagerduty:PA"]);
  });

  test("acknowledged counts as active", () => {
    const me = seed([{ id: "PA", priority: "P1", status: "acknowledged" }]);
    expect(selectPushCandidates(db, base(me))).toHaveLength(1);
  });

  test("negative controls: resolved / wrong severity / someone else's / already pushed", () => {
    const me = seed([
      { id: "PR", priority: "P1", status: "resolved" },
      { id: "P2", priority: "P2" },
      { id: "PO", priority: "P1", assignee: OTHER },
      { id: "PD", priority: "P1" },
      { id: "OK", priority: "P1" },
    ]);
    const ids = selectPushCandidates(db, {
      ...base(me),
      alreadyPushed: (id) => id === "pagerduty:PD",
    }).map((i) => i.id);
    expect(ids).toEqual(["pagerduty:OK"]);
  });

  test("enable boundary: inside the grace window is selected, before it is not", () => {
    const me = seed([
      { id: "IN", priority: "P1", createdAt: new Date(T0 - ENABLE_GRACE_MS + 1000).toISOString() },
      { id: "OUT", priority: "P1", createdAt: new Date(T0 - ENABLE_GRACE_MS - 1000).toISOString() },
    ]);
    const ids = selectPushCandidates(db, { ...base(me), enabledAtMs: T0 }).map((i) => i.id);
    expect(ids).toEqual(["pagerduty:IN"]);
  });

  test("no opened_at_ms → never selected (cannot be placed in time)", () => {
    const me = seed([{ id: "NT", priority: "P1", createdAt: null }]);
    expect(selectPushCandidates(db, base(me))).toEqual([]);
  });

  test("parity: candidates are a subset of what `nimbus oncall` calls mine", () => {
    const me = seed([
      { id: "A", priority: "P1" },
      { id: "B", priority: "P2" },
    ]);
    const mine = new Set(selectActiveAssignedIncidents(db, me).map((i) => i.id));
    for (const c of selectPushCandidates(db, base(me))) expect(mine.has(c.id)).toBe(true);
  });
});
