import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { canonicalJson } from "../util/canonical-json.ts";
import {
  configMap,
  HOUR,
  markSynced,
  resolverFor,
  serviceConfig,
  T0,
  writeCiRun,
  writeDeployment,
  writeMergedPr,
  writePagerdutyShift,
  writeSlackMessage,
} from "./__fixtures__/index-writers.ts";
import {
  writeBigeyeIssue,
  writeJsmAlert,
  writeMonteCarloIncident,
  writePagerdutyIncident,
  writeSentryIssue,
} from "./__fixtures__/trigger-writers.ts";
import { type AssembleDeps, assembleOne, IncidentError, recordHash } from "./assemble.ts";
import {
  CORE_KEYS,
  coreOf,
  type IncidentRecordV1,
  RECORD_FIELD_CLASS,
} from "./incident-record-types.ts";
import { getById, versionsOf } from "./incident-store.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const cfg = serviceConfig();
const resolver = resolverFor(cfg);
const OPEN = T0 + HOUR / 2;
const NOW = OPEN + 10 * 60_000;

function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

function deps(d: Database): AssembleDeps {
  return { db: d, loadServiceConfigs: () => configMap(cfg) };
}

function seedFull(d: Database, order: "forward" | "reverse" = "forward"): string {
  markSynced(d, "slack", T0);
  markSynced(d, "pagerduty", NOW);
  const writers: (() => unknown)[] = [
    () => writeDeployment(d, resolver),
    () => writeMergedPr(d, resolver),
    () => writeCiRun(d, resolver),
    () =>
      writeSlackMessage(d, {
        ts: "1.000001",
        text: "payment-service looks slow",
        atMs: OPEN + 60_000,
      }),
    () =>
      writeSlackMessage(d, {
        ts: "1.000002",
        text: "payment-service rollback?",
        atMs: OPEN + 60_000,
      }),
    () =>
      writePagerdutyIncident(
        d,
        { id: "OLD", openedAtMs: T0 - 5 * HOUR, status: "resolved", resolvedAtMs: T0 - 4 * HOUR },
        resolver,
      ),
    () =>
      writePagerdutyShift(d, {
        startMs: NOW - HOUR,
        endMs: NOW + HOUR,
        fetchedAtMs: NOW - 60_000,
        isMe: true,
      }),
  ];
  for (const w of order === "forward" ? writers : [...writers].reverse()) w();
  return writePagerdutyIncident(d, { id: "PD1", openedAtMs: OPEN, priority: "P1" }, resolver);
}

function stored(d: Database, id: string): IncidentRecordV1 {
  const row = getById(d, id);
  if (row === null) throw new Error("record missing");
  return JSON.parse(row.record_json) as IncidentRecordV1;
}

async function assemble(d: Database, itemId: string, now = NOW) {
  const r = await assembleOne(deps(d), itemId, now);
  if (r.outcome === "missing") throw new Error("missing");
  return r;
}

describe("assembleOne", () => {
  test("a PagerDuty P1 with every lane: rules, records and a rendered brief", async () => {
    const d = db();
    const item = seedFull(d);
    const r = await assemble(d, item);
    expect(r).toMatchObject({ outcome: "created", version: 1, status: "open" });
    const rec = stored(d, r.recordId);
    expect(rec.binding).toMatchObject({
      bound: true,
      service: "payment-service",
      via: "pagerduty_service",
    });
    expect(rec.change.deployment?.rule).toBe("last_deployment_before_open");
    expect(rec.change.pr?.rule).toBe("graph:deployed+merged_as");
    expect(rec.change.ci?.rule).toBe("graph:built_by");
    expect(rec.change.graphCorrelated).toBe(true);
    expect(rec.chat.messages.map((m) => m.rule)).toEqual([
      "chat_phrase:payment-service",
      "chat_phrase:payment-service",
    ]);
    expect(rec.prior.incidents.map((i) => i.id)).toEqual(["pagerduty:OLD"]);
    expect(rec.onCall).toMatchObject({ status: "ok", youAreOnCall: true });
    expect(rec.trigger).toMatchObject({ severity: "p1", opened: { ms: OPEN, basis: "provider" } });
    expect(rec.freshness.chatToMs).toBe(NOW);
    const row = getById(d, r.recordId);
    expect(row?.markdown).toContain("# Incident");
    expect(row?.markdown).toContain("Change candidate, the last deployment before the alert");
    expect(row?.markdown.toLowerCase()).not.toContain("root cause");
    expect(row?.cited_services).toBe(
      JSON.stringify(["github", "github-actions", "github_actions", "pagerduty", "slack"]),
    );
  });

  test("the same inputs twice give byte-identical record_json and markdown (determinism)", async () => {
    const a = db();
    const b = db();
    const ra = await assemble(a, seedFull(a));
    const rb = await assemble(b, seedFull(b));
    expect(getById(a, ra.recordId)?.record_json).toBe(getById(b, rb.recordId)?.record_json);
    expect(getById(a, ra.recordId)?.markdown).toBe(getById(b, rb.recordId)?.markdown);
  });

  test("a re-assembly at a later time over unchanged evidence is unchanged: one version, same hash", async () => {
    const d = db();
    const item = seedFull(d);
    const first = await assemble(d, item);
    const before = getById(d, first.recordId);
    const again = await assemble(d, item, NOW + 20 * 60_000);
    expect(again).toMatchObject({ outcome: "unchanged", version: 1 });
    const after = getById(d, first.recordId);
    expect(after?.record_sha256).toBe(before?.record_sha256);
    expect(after?.assembled_at_ms).toBe(NOW);
    expect(after?.checked_at_ms).toBe(NOW + 20 * 60_000);
    expect(versionsOf(d, first.recordId)).toHaveLength(1);
  });

  test("a last-synced change alone does not make a version (freshness is outside the hash)", async () => {
    const d = db();
    const item = seedFull(d);
    const first = await assemble(d, item);
    markSynced(d, "pagerduty", NOW + 5 * 60_000);
    expect((await assemble(d, item, NOW + 6 * 60_000)).outcome).toBe("unchanged");
    expect(versionsOf(d, first.recordId)).toHaveLength(1);
  });

  test("rows inserted in a different physical order (and tied times) assemble to the same hash", async () => {
    const a = db();
    const b = db();
    const ia = seedFull(a, "forward");
    const ib = seedFull(b, "reverse");
    const ra = await assemble(a, ia);
    const rb = await assemble(b, ib);
    expect(getById(a, ra.recordId)?.record_sha256).toBe(getById(b, rb.recordId)?.record_sha256);
  });

  test("new evidence is a new version; version 1 is untouched; a resolved status closes the record", async () => {
    const d = db();
    const item = seedFull(d);
    const first = await assemble(d, item);
    const v1 = stored(d, first.recordId);
    writeSlackMessage(d, { ts: "1.000003", text: "payment-service fixed", atMs: OPEN + 120_000 });
    const second = await assemble(d, item, NOW + 1000);
    expect(second).toMatchObject({ outcome: "updated", version: 2 });
    expect(stored(d, first.recordId).chat.total).toBe(3);
    const row = d
      .query("SELECT record_json FROM incident_record_version WHERE record_id = ? AND version = 1")
      .get(first.recordId) as { record_json: string };
    expect(JSON.parse(row.record_json)).toEqual(v1);
    writePagerdutyIncident(
      d,
      {
        id: "PD1",
        openedAtMs: OPEN,
        priority: "P1",
        status: "resolved",
        resolvedAtMs: OPEN + HOUR,
      },
      resolver,
    );
    const third = await assemble(d, item, NOW + 2000);
    expect(third).toMatchObject({ outcome: "updated", version: 3, status: "closed" });
    expect(stored(d, first.recordId).trigger).toMatchObject({
      status: "closed",
      closed: { ms: OPEN + HOUR, basis: "provider" },
    });
  });

  test("an unbound alert has lanes 2 to 5 skipped plus the unbound gap, and the engine bump changes the hash", async () => {
    const d = db();
    const id = writeJsmAlert(
      d,
      { id: "AL9", openedAtMs: OPEN, priority: "P1", tags: ["something-else"] },
      resolver,
    );
    const r = await assemble(d, id);
    const rec = stored(d, r.recordId);
    expect(rec.binding).toMatchObject({ bound: false, unboundReason: "unknown" });
    expect(rec.change.skipped).toBe("unbound");
    expect(rec.chat.skipped).toBe("unbound");
    expect(rec.prior.skipped).toBe("unbound");
    expect(rec.concurrent.skipped).toBeNull();
    expect(rec.onCall.status).toBe("skipped");
    expect(rec.gaps.some((g) => g.remediation?.includes("jsm_alert_tags"))).toBe(true);
    expect(recordHash({ ...rec, engine: rec.engine + 1 })).not.toBe(recordHash(rec));
  });

  test("every source assembles from its real writer; Bigeye has unknown status and no open time", async () => {
    const d = db();
    const ids = [
      writePagerdutyIncident(d, { id: "P", openedAtMs: OPEN, priority: "P1" }, resolver),
      writeJsmAlert(d, { id: "J", openedAtMs: OPEN, priority: "P1", tags: ["payments"] }, resolver),
      writeSentryIssue(d, { id: "S", level: "fatal", firstSeenMs: OPEN }, resolver),
      writeMonteCarloIncident(d, { id: "M", severity: "SEV-1", firstSeenMs: OPEN }, resolver),
      writeBigeyeIssue(d, { id: "B", slaStatus: "breached", syncedAtMs: OPEN }, resolver),
    ];
    for (const id of ids) {
      const r = await assemble(d, id);
      expect(r.outcome).toBe("created");
    }
    const bigeye = stored(d, (await assemble(d, ids[4] as string)).recordId);
    expect(bigeye.trigger).toMatchObject({
      status: "unknown",
      severity: null,
      slaStatus: "breached",
    });
    expect(bigeye.trigger.opened).toEqual({ ms: null, basis: "none" });
    expect(bigeye.change.skipped).toBe("no_open_time");
    expect(bigeye.concurrent.skipped).toBe("no_open_time");
    expect(bigeye.data?.models).toEqual(["analytics.payments.orders"]);
    expect(bigeye.gaps.some((g) => g.detail.includes("no open time"))).toBe(true);
    const mc = stored(d, (await assemble(d, ids[3] as string)).recordId);
    expect(mc.data).not.toBeNull();
    expect(mc.trigger.severity).toBe("sev1");
    const jsm = stored(d, (await assemble(d, ids[1] as string)).recordId);
    expect(jsm.data).toBeNull();
    expect(jsm.binding.via).toBe("jsm_alert_tag");
  });

  test("a Sentry issue that resolves gets an OBSERVED close time from item_history", async () => {
    const d = db();
    const id = writeSentryIssue(d, { id: "S", level: "fatal", firstSeenMs: OPEN }, resolver);
    writeSentryIssue(
      d,
      { id: "S", level: "fatal", status: "resolved", firstSeenMs: OPEN, lastSeenMs: OPEN + 1000 },
      resolver,
    );
    const rec = stored(d, (await assemble(d, id)).recordId);
    expect(rec.trigger.status).toBe("closed");
    expect(rec.trigger.closed.basis).toBe("observed");
    expect(rec.trigger.closed.ms).not.toBeNull();
  });

  test("malformed metadata does not throw: an unknown, unbound record with a gap", async () => {
    const d = db();
    d.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata) VALUES ('pagerduty:BAD','pagerduty','incident','BAD','Broken',1,1,'{nope')",
    );
    const r = await assemble(d, "pagerduty:BAD");
    const rec = stored(d, r.recordId);
    expect(rec.trigger.status).toBe("unknown");
    expect(rec.binding.unboundReason).toBe("metadata_unreadable");
  });

  test("a missing item is 'missing' and a non-trigger item throws ERR_INCIDENT_NOT_A_TRIGGER", async () => {
    const d = db();
    expect(await assembleOne(deps(d), "pagerduty:nope", NOW)).toEqual({ outcome: "missing" });
    d.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES ('github:1','github','issue','1','t',1,1)",
    );
    await expect(assembleOne(deps(d), "github:1", NOW)).rejects.toMatchObject({
      name: "IncidentError",
      code: "ERR_INCIDENT_NOT_A_TRIGGER",
    });
    expect(new IncidentError("ERR_INCIDENT_NOT_FOUND", "x").code).toBe("ERR_INCIDENT_NOT_FOUND");
  });
});

describe("the hashed core", () => {
  function walkKeys(v: unknown, out: Set<string>): void {
    if (Array.isArray(v)) {
      for (const x of v) walkKeys(x, out);
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        out.add(k);
        walkKeys(x, out);
      }
    }
  }

  test("the core has exactly CORE_KEYS and none of the volatile names appears anywhere in it", async () => {
    const d = db();
    const rec = stored(d, (await assemble(d, seedFull(d))).recordId);
    expect(Object.keys(coreOf(rec))).toEqual([...CORE_KEYS]);
    const keys = new Set<string>();
    walkKeys(JSON.parse(canonicalJson(coreOf(rec))), keys);
    for (const k of [
      "version",
      "assembledAtMs",
      "freshness",
      "markdown",
      "toMs",
      "stale",
      "oldestFetchedMs",
    ]) {
      expect(keys.has(k), k).toBe(false);
    }
  });

  test("version, assembledAtMs and freshness do not move the hash; flipping any core field does", async () => {
    const d = db();
    const rec = stored(d, (await assemble(d, seedFull(d))).recordId);
    const base = recordHash(rec);
    expect(recordHash({ ...rec, version: 7 })).toBe(base);
    expect(recordHash({ ...rec, assembledAtMs: 1 })).toBe(base);
    expect(recordHash({ ...rec, freshness: { rows: [], chatToMs: 5, onCallStale: true } })).toBe(
      base,
    );
    const flips: Record<(typeof CORE_KEYS)[number], IncidentRecordV1> = {
      schema: { ...rec, schema: 2 as never },
      engine: { ...rec, engine: rec.engine + 1 },
      trigger: { ...rec, trigger: { ...rec.trigger, title: "other" } },
      binding: { ...rec, binding: { ...rec.binding, via: "repo" } },
      change: { ...rec, change: { ...rec.change, graphCorrelated: false } },
      chat: { ...rec, chat: { ...rec.chat, total: rec.chat.total + 1 } },
      prior: { ...rec, prior: { ...rec.prior, total: rec.prior.total + 1 } },
      concurrent: { ...rec, concurrent: { ...rec.concurrent, total: 9 } },
      data: {
        ...rec,
        data: {
          models: [],
          lineage: [],
          orchestration: [],
          prs: [],
          totals: { lineage: 0, orchestration: 0, prs: 0 },
        },
      },
      onCall: { ...rec, onCall: { ...rec.onCall, youAreOnCall: false } },
      history: { ...rec, history: { ...rec.history, total: 99 } },
      gaps: { ...rec, gaps: [...rec.gaps, { category: "missing_connector", detail: "x" }] },
      counts: { ...rec, counts: { ...rec.counts, chat: 99 } },
    };
    for (const key of CORE_KEYS) expect(recordHash(flips[key]), key).not.toBe(base);
    for (const [k, cls] of Object.entries(RECORD_FIELD_CLASS)) {
      expect(CORE_KEYS.includes(k as never), k).toBe(cls === "core");
    }
  });

  test("an unclassified field is a compile error", () => {
    // @ts-expect-error a field missing from the class table does not satisfy Record<keyof IncidentRecordV1, ...>
    const bad: Record<keyof IncidentRecordV1, "core" | "volatile"> = { schema: "core" };
    expect(Object.keys(bad)).toEqual(["schema"]);
  });
});

describe("what a record holds", () => {
  test("no key named email, body or description anywhere, and no e-mail address in the JSON", async () => {
    const d = db();
    const id = seedFull(d);
    const rec = stored(d, (await assemble(d, id)).recordId);
    const keys = new Set<string>();
    (function walk(v: unknown): void {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k.toLowerCase());
          walk(x);
        }
      }
    })(rec);
    for (const k of keys) expect(/email|body|description/.test(k), k).toBe(false);
    expect(JSON.stringify(rec)).not.toContain("@acme.test");
  });

  test("a record over 64 KiB is cut in a fixed order and says so; the true counts survive", async () => {
    const d = db();
    markSynced(d, "slack", T0);
    const id = writePagerdutyIncident(d, { id: "BIG", openedAtMs: OPEN, priority: "P1" }, resolver);
    const emoji = "\u{1F600}".repeat(190);
    for (let i = 0; i < 60; i += 1) {
      writeSlackMessage(d, {
        ts: `${String(10 + i)}.000001`,
        text: `payment-service ${emoji} ${String(i)}`,
        atMs: OPEN + i,
      });
    }
    d.run("DELETE FROM item_history WHERE item_id = ?", [id]);
    for (let i = 0; i < 40; i += 1) {
      d.run(
        "INSERT INTO item_history (item_id, service, type, key, old_value, new_value, observed_at_ms) VALUES (?, 'pagerduty', 'incident', 'status', ?, ?, ?)",
        [id, emoji, emoji + String(i), T0 + i],
      );
    }
    const r = await assemble(d, id);
    const row = getById(d, r.recordId);
    expect(new TextEncoder().encode(row?.record_json ?? "").length).toBeLessThanOrEqual(
      65_536 + 4096,
    );
    const rec = stored(d, r.recordId);
    expect(rec.counts.chat).toBe(60);
    expect(rec.chat.total).toBe(60);
    expect(rec.gaps.some((g) => g.detail.includes("cut to fit its size cap"))).toBe(true);
  });

  test("history that begins after the open time says so, and every time carries a basis", async () => {
    const d = db();
    const id = writePagerdutyIncident(
      d,
      { id: "H", openedAtMs: T0 - 100 * HOUR, priority: "P1" },
      resolver,
    );
    // the sync stamps observation times with the wall clock; pin them after the open time
    d.run("UPDATE item_history SET observed_at_ms = ?", [T0]);
    const rec = stored(d, (await assemble(d, id)).recordId);
    expect(rec.gaps.some((g) => g.detail.includes("first observed state stands in"))).toBe(true);
    expect(rec.trigger.opened.basis).toBe("provider");
    expect(rec.trigger.firstObservedMs).not.toBeNull();
  });
});
