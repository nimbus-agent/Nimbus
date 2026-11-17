import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { DEFAULT_INCIDENT_CONFIG } from "../config/incident-toml.ts";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { configMap, resolverFor, serviceConfig, T0 } from "./__fixtures__/index-writers.ts";
import { writePagerdutyIncident } from "./__fixtures__/trigger-writers.ts";
import { createIncidentEngine } from "./incident-engine.ts";
import { readTimeline, TIMELINE_HISTORY_CAP } from "./timeline-read.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const cfg = serviceConfig();
const resolver = resolverFor(cfg);
const NOW = T0 + 2 * 3_600_000;

async function seeded(): Promise<{ d: Database; recordId: string; item: string }> {
  const d = createMemoryIndexDb();
  dbs.push(d);
  let clock = NOW;
  const engine = createIncidentEngine({
    db: d,
    now: () => clock,
    emit: () => {},
    loadServiceConfigs: () => configMap(cfg),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
    yieldToEventLoop: async () => {},
  });
  const item = writePagerdutyIncident(d, { id: "TL1", openedAtMs: T0, priority: "P1" }, resolver);
  await engine.assembleNow(item);
  // a change after version 1, so version 2 exists
  clock = NOW + 600_000;
  writePagerdutyIncident(
    d,
    {
      id: "TL1",
      openedAtMs: T0,
      status: "acknowledged",
      updatedAtMs: T0 + 300_000,
      priority: "P1",
    },
    resolver,
  );
  await engine.assembleNow(item);
  const recordId = (d.query("SELECT id FROM incident_record").get() as { id: string }).id;
  return { d, recordId, item };
}

const link = (id: string, version: number): string =>
  `{"incident":{"id":"${id}","version":${String(version)}}`;

describe("6.6 / 6.7 readTimeline", () => {
  test("reads the current version with the trigger's history and the linked actions", async () => {
    const { d, recordId } = await seeded();
    d.run(
      "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash) VALUES (?,?,?,?,?,?)",
      [
        "email.send",
        "approved",
        `${link(recordId, 1)},"action":{"type":"email.send"},"answerSource":"human"}`,
        NOW + 1,
        "h",
        "p",
      ],
    );
    const r = readTimeline(d, recordId);
    expect(r.version).toBe(r.currentVersion);
    const kinds = r.timeline.events.map((e) => e.kind);
    expect(kinds).toContain("opened");
    expect(kinds).toContain("state_change");
    expect(kinds).toContain("action_approved");
    // no `__created` bookkeeping line
    expect(r.timeline.events.every((e) => !e.text.startsWith("__"))).toBe(true);
  });

  test("--version N shows what was known then: later actions and later history are left out", async () => {
    const { d, recordId } = await seeded();
    d.run(
      "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash) VALUES (?,?,?,?,?,?)",
      [
        "email.send",
        "approved",
        `${link(recordId, 2)},"action":{"type":"email.send"}}`,
        NOW + 1,
        "h",
        "p",
      ],
    );
    const v1 = readTimeline(d, recordId, 1);
    expect(v1.version).toBe(1);
    expect(v1.timeline.events.map((e) => e.kind)).not.toContain("action_approved");
    const v2 = readTimeline(d, recordId, 2);
    expect(v2.timeline.events.map((e) => e.kind)).toContain("action_approved");
  });

  test("asking for the CURRENT version applies the same assembly-time cutoff as an older one", async () => {
    const { d, recordId, item } = await seeded();
    const current = d.query("SELECT version, assembled_at_ms FROM incident_record").get() as {
      version: number;
      assembled_at_ms: number;
    };
    // history observed AFTER the current version was assembled
    d.run(
      "INSERT INTO item_history (item_id, service, type, key, old_value, new_value, observed_at_ms) VALUES (?, 'pagerduty', 'incident', 'urgency', 'low', 'later-state', ?)",
      [item, current.assembled_at_ms + 1_000],
    );
    const text = (r: ReturnType<typeof readTimeline>): string =>
      r.timeline.events.map((e) => e.text).join("\n");
    expect(text(readTimeline(d, recordId, current.version))).not.toContain("later-state");
    // with no version the unrestricted read still shows it
    expect(text(readTimeline(d, recordId))).toContain("later-state");
  });

  test("a read with no gate row after it is no approval: the timeline leaves it out", async () => {
    const { d, recordId } = await seeded();
    d.run(
      "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash) VALUES (?,?,?,?,?,?)",
      [
        "jira.before.read",
        "not_required",
        `${link(recordId, 1)},"step":"0123456789abcdef","subStep":true,"action":{"type":"jira.before.read"}}`,
        NOW + 1,
        "h",
        "p",
      ],
    );
    const kinds = readTimeline(d, recordId).timeline.events.map((e) => e.kind);
    expect(kinds).not.toContain("action_approved");
    expect(kinds).not.toContain("action_denied");
  });

  test("an unknown record or a pruned or unknown version is a typed error", async () => {
    const { d, recordId } = await seeded();
    expect(() => readTimeline(d, "inc_ffffffffffffffff")).toThrow(/no incident record/);
    try {
      readTimeline(d, recordId, 99);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("ERR_INCIDENT_VERSION_NOT_FOUND");
    }
    d.run("DELETE FROM incident_record_version WHERE record_id = ? AND version = 1", [recordId]);
    expect(() => readTimeline(d, recordId, 1)).toThrow(/no version 1/);
  });

  test("more than 200 history rows read the oldest 200 and say so", async () => {
    const { d, recordId, item } = await seeded();
    d.exec("BEGIN");
    for (let i = 0; i < TIMELINE_HISTORY_CAP + 5; i += 1) {
      d.run(
        "INSERT INTO item_history (item_id, service, type, key, old_value, new_value, observed_at_ms) VALUES (?, 'pagerduty', 'incident', 'urgency', 'a', 'b', ?)",
        [item, T0 + i],
      );
    }
    d.exec("COMMIT");
    const r = readTimeline(d, recordId);
    expect(r.timeline.events.filter((e) => e.kind === "state_change")).toHaveLength(
      TIMELINE_HISTORY_CAP,
    );
    expect(r.timeline.notes.join(" ")).toContain("oldest 200");
  });
});
