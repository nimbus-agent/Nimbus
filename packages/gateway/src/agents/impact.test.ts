import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { emitImpactBrief, runImpact } from "./impact.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

describe("runImpact", () => {
  test("returns a structurally valid ImpactBrief on an empty index", async () => {
    const db = freshDb();
    const brief = await runImpact(
      { fileOrPrUrl: "src/billing/retry.ts" },
      { db, sessionId: "t-1", notify: () => {} },
    );
    expect(brief.kind).toBe("impact");
    expect(brief.agentVersion).toBe(1);
    expect(brief.query.fileOrPrUrl).toBe("src/billing/retry.ts");
    expect(Array.isArray(brief.affected)).toBe(true);
    expect(Array.isArray(brief.gaps)).toBe(true);
    // Empty index → at least one empty_index gap.
    expect(brief.gaps.some((g) => g.category === "empty_index")).toBe(true);
    // Latency captured.
    expect(typeof brief.latencyMs).toBe("number");
  });

  test("resolves a PR URL to a graph_entity and emits a downstream_repo finding", async () => {
    const db = freshDb();
    // Seed a `pr` graph_entity matching the PR URL → resolveStartEntity hits
    // PR_URL_RE branch (Branch 1). Also seed a `repo` graph_entity so
    // subDownstreamRepos returns a finding instead of an empty result.
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:pr:1', 'pr', 'github:acme/payment#501', 'acme/payment#501', 'github', '{}')",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:repo:1', 'repo', 'github:acme/payment', 'acme/payment', 'github', '{}')",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "https://github.com/acme/payment/pull/501", depth: 3 },
      { db, sessionId: "t-pr", notify: () => {} },
    );
    expect(brief.startEntityId).toBe("graph:pr:1");
    // subDownstreamRepos finds the linked repo (service-bucket finding).
    const serviceFindings = brief.affected.filter((f) => f.category === "service");
    expect(serviceFindings.length).toBe(1);
    expect(serviceFindings[0]?.affectedItemId).toBe("graph:repo:1");
  });

  test("emitImpactBrief returns a sessionId and emits a Markdown brief via notify (LLM-disabled deterministic path)", async () => {
    const db = freshDb();
    const received: Array<{ method: string; params: unknown }> = [];
    const handle = await emitImpactBrief(
      { fileOrPrUrl: "src/missing.ts" },
      {
        db,
        sessionId: "t-emit",
        // No `llm` → synthesize() falls through to deterministicRender (the
        // _lib/render.ts renderImpact path).
        notify: (method, params) => {
          received.push({ method, params });
        },
      },
    );
    expect(handle.sessionId).toBe("t-emit");
    // Wait for the fire-and-forget async to land. Three short ticks is enough
    // because runImpact on an empty DB performs only constant-time SQL.
    for (let i = 0; i < 20 && received.length === 0; i += 1) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(received.length).toBe(1);
    const evt = received[0];
    expect(evt?.method).toBe("impact.briefReady");
    const params = evt?.params as { sessionId: string; brief: string };
    expect(params.sessionId).toBe("t-emit");
    // Deterministic Markdown header proves _lib/render.ts ran.
    expect(params.brief).toContain("# Impact: src/missing.ts");
    expect(typeof params.brief).toBe("string");
  });

  test("aggregates near-duplicate missing-entity gaps into one combined note", async () => {
    const db = freshDb();
    // Seed one item so detectEmptyIndex passes.
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed', 'github', 'pr', 'acme/x#1', 't', '', 0, 0, 0)",
    );
    // Seed a `symbol` graph_entity so resolveStartEntity returns non-null and
    // sub-agents reach their SQL bodies (instead of early-returning on null start).
    // subPipelines will emit detectMissingEntityType(db, "pipeline_run") gap;
    // subDashboards will emit detectMissingEntityType(db, "dashboard") gap.
    // Two missing_entity_type gaps → aggregateMissingEntityTypes folds them into one.
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:symbol:test', 'symbol', 'item:filesystem:src/x.ts', 'src/x.ts', 'filesystem', '{}')",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "src/x.ts" },
      { db, sessionId: "t-2", notify: () => {} },
    );
    // Two missing_entity_type gaps fire (pipeline_run + dashboard); aggregator
    // collapses them into exactly one combined note.
    const missingEntityGaps = brief.gaps.filter((g) => g.category === "missing_entity_type");
    expect(missingEntityGaps.length).toBe(1);
    expect(missingEntityGaps[0]?.detail).toMatch(/categories blocked/);
  });

  test("subDownstreamCode emits a downstream_repo finding via reverse `depends_on`", async () => {
    // Covers lines 272-285 — reverse depends_on walk from the resolved start.
    const db = freshDb();
    // Seed one item so detectEmptyIndex passes.
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed', 'github', 'pr', 'acme/x#1', 't', '', 0, 0, 0)",
    );
    // Resolved start: a `symbol` entity for src/target.ts.
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:symbol:target', 'symbol', 'item:filesystem:src/target.ts', 'src/target.ts', 'filesystem', '{}')",
    );
    // Upstream consumer entity that `depends_on` the target — reverse traversal
    // (r.to_id = start, return r.from_id) finds this row.
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:symbol:consumer', 'symbol', 'item:filesystem:src/consumer.ts', 'src/consumer.ts', 'filesystem', '{}')",
    );
    db.run(
      "INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES " +
        "('graph:symbol:consumer', 'graph:symbol:target', 'depends_on', 0)",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "src/target.ts" },
      { db, sessionId: "t-dc", notify: () => {} },
    );
    const downstreamCode = brief.affected.filter((f) => f.category === "downstream_repo");
    expect(downstreamCode.length).toBe(1);
    expect(downstreamCode[0]?.affectedItemId).toBe("graph:symbol:consumer");
    expect(downstreamCode[0]?.pathSummary).toContain("depends_on");
  });

  test("subOncall surfaces a missing_connector gap when PagerDuty is not configured", async () => {
    // Covers lines 353-354 — detectMissingConnector returns the gap BEFORE the
    // SQL traversal even runs. Confirms PagerDuty absence yields a structured
    // gap (not silent emptiness) with the recommended remediation.
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed', 'github', 'pr', 'acme/x#1', 't', '', 0, 0, 0)",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:symbol:s', 'symbol', 'item:filesystem:src/s.ts', 'src/s.ts', 'filesystem', '{}')",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "src/s.ts" },
      { db, sessionId: "t-oc-miss", notify: () => {} },
    );
    const missingConnectorGaps = brief.gaps.filter(
      (g) => g.category === "missing_connector" && g.detail.includes("pagerduty"),
    );
    expect(missingConnectorGaps.length).toBeGreaterThanOrEqual(1);
  });

  test("subOncall emits an oncall_rotation finding via `belongs_to` when PagerDuty is configured", async () => {
    // Covers lines 364-385 — service → belongs_to → oncall_rotation traversal.
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed', 'github', 'pr', 'acme/x#1', 't', '', 0, 0, 0)",
    );
    // PagerDuty is "configured" → sync_state row makes detectMissingConnector
    // return null and the SQL traversal proceeds.
    db.run(
      "INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token) VALUES " +
        "('pagerduty', 0, '')",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:symbol:s', 'symbol', 'item:filesystem:src/s.ts', 'src/s.ts', 'filesystem', '{}')",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:oncall:r1', 'oncall_rotation', 'pagerduty:rot-1', 'Primary On-Call', 'pagerduty', '{}')",
    );
    db.run(
      "INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES " +
        "('graph:symbol:s', 'graph:oncall:r1', 'belongs_to', 0)",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "src/s.ts" },
      { db, sessionId: "t-oc-hit", notify: () => {} },
    );
    const oncallFindings = brief.affected.filter((f) => f.category === "oncall_rotation");
    expect(oncallFindings.length).toBe(1);
    expect(oncallFindings[0]?.affectedItemId).toBe("graph:oncall:r1");
    expect(oncallFindings[0]?.serviceId).toBe("pagerduty");
  });

  test("subDashboards emits a dashboard finding via `upstream_refs` when dashboard entities exist", async () => {
    // Covers lines 398-423 — start non-null + dashboard entity present means
    // detectMissingEntityType returns null and the SQL traversal runs.
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed', 'github', 'pr', 'acme/x#1', 't', '', 0, 0, 0)",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:symbol:s', 'symbol', 'item:filesystem:src/s.ts', 'src/s.ts', 'filesystem', '{}')",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:dash:1', 'dashboard', 'metabase:42', 'Revenue Dashboard', 'metabase', '{}')",
    );
    // `upstream_refs` isn't pre-populated in graph_relation_type by current
    // migrations — register it just to satisfy the FK so we can exercise the
    // sub-agent's SQL.
    db.run(
      "INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES ('upstream_refs', 1)",
    );
    db.run(
      "INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES " +
        "('graph:symbol:s', 'graph:dash:1', 'upstream_refs', 0)",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "src/s.ts" },
      { db, sessionId: "t-dash", notify: () => {} },
    );
    const dashFindings = brief.affected.filter((f) => f.category === "dashboard");
    expect(dashFindings.length).toBe(1);
    expect(dashFindings[0]?.affectedItemId).toBe("graph:dash:1");
    expect(dashFindings[0]?.pathSummary).toContain("upstream_refs");
  });

  test("resolveStartEntity branch 3 — topic FTS on item.body_preview", async () => {
    // Covers line 219 — when neither a PR URL nor a symbol matches but item
    // title/body_preview LIKE matches, returns entityId = `item:<id>`.
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('topic:1', 'notion', 'page', 'note-1', 'Untitled', 'OAuth refresh token rotation strategy', 1000, 0, 0)",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "OAuth refresh token" },
      { db, sessionId: "t-topic", notify: () => {} },
    );
    // Start entity matched the topic FTS branch (returns "item:<id>").
    expect(brief.startEntityId).toBe("item:topic:1");
  });

  test("emitImpactBrief routes synchronous errors in runImpact to impact.briefError", async () => {
    // Covers lines 137-140 — the .catch handler on the fire-and-forget IIFE.
    // Closing the DB before runImpact runs makes the first SQL query throw.
    const db = freshDb();
    db.close();
    const received: Array<{ method: string; params: unknown }> = [];
    const handle = await emitImpactBrief(
      { fileOrPrUrl: "src/anything.ts" },
      {
        db,
        sessionId: "t-err",
        notify: (method, params) => {
          received.push({ method, params });
        },
      },
    );
    expect(handle.sessionId).toBe("t-err");
    for (let i = 0; i < 40 && received.length === 0; i += 1) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(received.length).toBe(1);
    const evt = received[0];
    expect(evt?.method).toBe("impact.briefError");
    const params = evt?.params as { sessionId: string; error: string };
    expect(params.sessionId).toBe("t-err");
    expect(typeof params.error).toBe("string");
  });
});
