import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { renderIncidentPostmortem } from "../agents/_lib/incident-postmortem-render.ts";
import { DEFAULT_INCIDENT_CONFIG } from "../config/incident-toml.ts";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { configMap, resolverFor, serviceConfig, T0 } from "./__fixtures__/index-writers.ts";
import { writePagerdutyIncident } from "./__fixtures__/trigger-writers.ts";
import { IncidentError } from "./assemble.ts";
import { createIncidentEngine } from "./incident-engine.ts";
import { buildPostmortemBrief, PostmortemError } from "./postmortem-brief.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const cfg = serviceConfig();
const resolver = resolverFor(cfg);
const NOW = T0 + 4 * 3_600_000;

type Seed = { d: Database; recordId: string; item: string };

async function seed(status: "triggered" | "resolved"): Promise<Seed> {
  const d = createMemoryIndexDb();
  dbs.push(d);
  const engine = createIncidentEngine({
    db: d,
    now: () => NOW,
    emit: () => {},
    loadServiceConfigs: () => configMap(cfg),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
    yieldToEventLoop: async () => {},
  });
  const item = writePagerdutyIncident(d, { id: "PM1", openedAtMs: T0, priority: "P1" }, resolver);
  if (status === "resolved") {
    writePagerdutyIncident(
      d,
      {
        id: "PM1",
        openedAtMs: T0,
        status: "resolved",
        resolvedAtMs: T0 + 95 * 60_000,
        priority: "P1",
      },
      resolver,
    );
  }
  await engine.assembleNow(item);
  const recordId = (d.query("SELECT id FROM incident_record").get() as { id: string }).id;
  return { d, recordId, item };
}

const link = (id: string, version: number, extra = ""): string =>
  `{"incident":{"id":"${id}","version":${String(version)}}${extra}`;

function audit(d: Database, type: string, status: string, json: string, ts: number): void {
  d.run(
    "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash) VALUES (?,?,?,?,?,?)",
    [type, status, json, ts, "h", "p"],
  );
}

describe("buildPostmortemBrief", () => {
  test("a record whose trigger is not closed is refused, with a fixed code and no record text", async () => {
    const { d, recordId } = await seed("triggered");
    let caught: unknown;
    try {
      buildPostmortemBrief(d, recordId, NOW, null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PostmortemError);
    expect((caught as PostmortemError).code).toBe("ERR_POSTMORTEM_NOT_RESOLVED");
  });

  test("an unknown record id is the IC3 not-found error", () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    expect(() => buildPostmortemBrief(d, "inc_0000000000000000", NOW, null)).toThrow(IncidentError);
  });

  test("a resolved PagerDuty incident builds a brief with the provider's resolution time", async () => {
    const { d, recordId } = await seed("resolved");
    const b = buildPostmortemBrief(d, recordId, NOW, null);
    expect(b.kind).toBe("incident_postmortem");
    expect(b.recordId).toBe(recordId);
    expect(b.impact.openedMs).toBe(T0);
    expect(b.impact.resolvedMs).toBe(T0 + 95 * 60_000);
    expect(b.timeline.events.map((e) => e.kind)).toContain("opened");
    const md = renderIncidentPostmortem(b);
    expect(md).toContain("- Duration: 95 min");
  });

  test("the gaps say why no cascade and no action items are shown, once each, and keep the record's own", async () => {
    const { d, recordId } = await seed("resolved");
    const b = buildPostmortemBrief(d, recordId, NOW, null);
    const details = b.gaps.map((g) => g.detail);
    expect(details.filter((x) => x.startsWith("No cascade is shown"))).toHaveLength(1);
    expect(details.filter((x) => x.includes("Runbook step state"))).toHaveLength(1);
    expect(details.filter((x) => x.includes("records the decision"))).toHaveLength(1);
    expect(new Set(details).size).toBe(details.length);
  });

  test("with no provider closed time, the resolution comes from the trigger's status history", async () => {
    const { d, recordId, item } = await seed("resolved");
    // The record keeps the provider time; remove it from the stored JSON and add a history row.
    const row = d.query("SELECT record_json FROM incident_record WHERE id = ?").get(recordId) as {
      record_json: string;
    };
    const rec = JSON.parse(row.record_json);
    rec.trigger.closed = { ms: null, basis: "none" };
    d.run("UPDATE incident_record SET record_json = ? WHERE id = ?", [
      JSON.stringify(rec),
      recordId,
    ]);
    d.run(
      "INSERT INTO item_history (item_id, service, type, key, old_value, new_value, observed_at_ms, source_at_ms) VALUES (?, 'pagerduty', 'incident', 'status', 'triggered', 'resolved', ?, ?)",
      [item, T0 + 200_000, T0 + 100_000],
    );
    const b = buildPostmortemBrief(d, recordId, NOW, null);
    expect(b.impact.resolvedMs).toBe(T0 + 100_000);
    expect(b.impact.resolvedBasis).toBe("history");
    // a history row whose new value is not a closed word does not count
    d.run(
      "INSERT INTO item_history (item_id, service, type, key, old_value, new_value, observed_at_ms) VALUES (?, 'pagerduty', 'incident', 'status', 'resolved', 'triggered', ?)",
      [item, T0 + 900_000],
    );
    const again = buildPostmortemBrief(d, recordId, NOW, null);
    expect(again.impact.resolvedMs).toBeNull();
    expect(again.impact.resolvedBasis).toBe("none");
  });

  test("a closed record with no close time and no status history has an unrecorded resolution", async () => {
    const { d, recordId, item } = await seed("resolved");
    const row = d.query("SELECT record_json FROM incident_record WHERE id = ?").get(recordId) as {
      record_json: string;
    };
    const rec = JSON.parse(row.record_json);
    rec.trigger.closed = { ms: null, basis: "none" };
    d.run("UPDATE incident_record SET record_json = ? WHERE id = ?", [
      JSON.stringify(rec),
      recordId,
    ]);
    d.run("DELETE FROM item_history WHERE item_id = ?", [item]);
    const b = buildPostmortemBrief(d, recordId, NOW, null);
    expect(b.impact.resolvedMs).toBeNull();
    expect(b.impact.resolvedBasis).toBe("none");
  });

  test("an observed close time and a first-observed open time carry their basis", async () => {
    const { d, recordId } = await seed("resolved");
    const row = d.query("SELECT record_json FROM incident_record WHERE id = ?").get(recordId) as {
      record_json: string;
    };
    const rec = JSON.parse(row.record_json);
    rec.trigger.opened = { ms: null, basis: "none" };
    rec.trigger.firstObservedMs = T0 + 5;
    rec.trigger.closed = { ms: T0 + 9, basis: "observed" };
    d.run("UPDATE incident_record SET record_json = ? WHERE id = ?", [
      JSON.stringify(rec),
      recordId,
    ]);
    const b = buildPostmortemBrief(d, recordId, NOW, null);
    expect(b.impact).toEqual({
      openedMs: T0 + 5,
      openedBasis: "observed",
      resolvedMs: T0 + 9,
      resolvedBasis: "observed",
    });
    rec.trigger.firstObservedMs = null;
    d.run("UPDATE incident_record SET record_json = ? WHERE id = ?", [
      JSON.stringify(rec),
      recordId,
    ]);
    expect(buildPostmortemBrief(d, recordId, NOW, null).impact.openedBasis).toBe("none");
  });

  test("the linked actions are listed in audit order with verdict, answer source and prompt; reads are not actions", async () => {
    const { d, recordId } = await seed("resolved");
    const sha = "ab".repeat(32);
    // a before-state read (sub-step) is recorded BEFORE the action's own gate row
    audit(
      d,
      "confluence.before.read",
      "not_required",
      `${link(recordId, 1, `,"step":"0123456789abcdef","subStep":true`)},"action":{}}`,
      NOW + 1,
    );
    audit(
      d,
      "confluence.page.create",
      "approved",
      `${link(recordId, 1, `,"step":"0123456789abcdef","promptSha256":"${sha}","prompt":"Action requires your approval"`)},"action":{"type":"confluence.page.create"},"answerSource":"human"}`,
      NOW + 2,
    );
    audit(
      d,
      "notion.page.create",
      "rejected",
      `${link(recordId, 1, `,"step":"fedcba9876543210"`)},"action":{"type":"notion.page.create"},"answerSource":"human"}`,
      NOW + 3,
    );
    // a row for another record, and one that only spells a link inside its payload
    audit(d, "x.y", "approved", `${link("inc_ffffffffffffffff", 1)},"action":{}}`, NOW + 4);
    audit(d, "x.z", "approved", `{"action":{"note":"${link(recordId, 1)}"}}`, NOW + 5);
    const b = buildPostmortemBrief(d, recordId, NOW, null);
    expect(b.actions.map((a) => [a.actionType, a.verdict, a.answerSource, a.subSteps])).toEqual([
      ["confluence.page.create", "approved", "human", 1],
      ["notion.page.create", "denied", "human", 0],
    ]);
    expect(b.actions[0]?.prompt).toEqual({
      sha256: sha,
      text: "Action requires your approval",
      cut: false,
    });
    expect(b.actions[1]?.prompt).toBeNull();
    expect(b.actionsTruncated).toBe(false);
  });

  test("an undo is listed as undone", async () => {
    const { d, recordId } = await seed("resolved");
    audit(d, "github.pr.undo", "approved", `${link(recordId, 1)},"action":{}}`, NOW + 2);
    const b = buildPostmortemBrief(d, recordId, NOW, null);
    expect(b.actions[0]?.verdict).toBe("undone");
  });

  test("a template given to the builder rides on the brief", async () => {
    const { d, recordId } = await seed("resolved");
    const template = { parts: [{ kind: "section" as const, id: "summary" as const }] };
    expect(buildPostmortemBrief(d, recordId, NOW, template).template).toBe(template);
  });
});
