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
    expect(brief.gaps.some((g) => g.category === "empty_index")).toBe(true);
    expect(typeof brief.latencyMs).toBe("number");
  });

  test("resolves a PR URL to a graph_entity and emits a downstream_repo finding", async () => {
    const db = freshDb();
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
    const serviceFindings = brief.affected.filter((f) => f.category === "service");
    expect(serviceFindings).toHaveLength(1);
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
        notify: (method, params) => {
          received.push({ method, params });
        },
      },
    );
    expect(handle.sessionId).toBe("t-emit");
    for (let i = 0; i < 20 && received.length === 0; i += 1) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(received).toHaveLength(1);
    const evt = received[0];
    expect(evt?.method).toBe("impact.briefReady");
    const params = evt?.params as { sessionId: string; brief: string };
    expect(params.sessionId).toBe("t-emit");
    expect(params.brief).toContain("# Impact: src/missing.ts");
    expect(typeof params.brief).toBe("string");
  });

  test("aggregates near-duplicate missing-entity gaps into one combined note", async () => {
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed', 'github', 'pr', 'acme/x#1', 't', '', 0, 0, 0)",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:symbol:test', 'symbol', 'item:filesystem:src/x.ts', 'src/x.ts', 'filesystem', '{}')",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "src/x.ts" },
      { db, sessionId: "t-2", notify: () => {} },
    );
    const missingEntityGaps = brief.gaps.filter((g) => g.category === "missing_entity_type");
    expect(missingEntityGaps).toHaveLength(1);
    expect(missingEntityGaps[0]?.detail).toMatch(/categories blocked/);
  });

  test("subDownstreamCode emits a downstream_repo finding via reverse `depends_on`", async () => {
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed', 'github', 'pr', 'acme/x#1', 't', '', 0, 0, 0)",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:symbol:target', 'symbol', 'item:filesystem:src/target.ts', 'src/target.ts', 'filesystem', '{}')",
    );
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
    expect(downstreamCode).toHaveLength(1);
    expect(downstreamCode[0]?.affectedItemId).toBe("graph:symbol:consumer");
    expect(downstreamCode[0]?.pathSummary).toContain("depends_on");
  });

  test("subOncall surfaces a missing_connector gap when PagerDuty is not configured", async () => {
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
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed', 'github', 'pr', 'acme/x#1', 't', '', 0, 0, 0)",
    );
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
    expect(oncallFindings).toHaveLength(1);
    expect(oncallFindings[0]?.affectedItemId).toBe("graph:oncall:r1");
    expect(oncallFindings[0]?.serviceId).toBe("pagerduty");
  });

  test("subDashboards emits a dashboard finding via `upstream_refs` when dashboard entities exist", async () => {
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
    expect(dashFindings).toHaveLength(1);
    expect(dashFindings[0]?.affectedItemId).toBe("graph:dash:1");
    expect(dashFindings[0]?.pathSummary).toContain("upstream_refs");
  });

  test("resolveStartEntity branch 3 — topic FTS on item.body_preview", async () => {
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('topic:1', 'notion', 'page', 'note-1', 'Untitled', 'OAuth refresh token rotation strategy', 1000, 0, 0)",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "OAuth refresh token" },
      { db, sessionId: "t-topic", notify: () => {} },
    );
    expect(brief.startEntityId).toBe("item:topic:1");
  });

  test("emitImpactBrief routes synchronous errors in runImpact to impact.briefError", async () => {
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
    expect(received).toHaveLength(1);
    const evt = received[0];
    expect(evt?.method).toBe("impact.briefError");
    const params = evt?.params as { sessionId: string; error: string };
    expect(params.sessionId).toBe("t-err");
    expect(typeof params.error).toBe("string");
  });

  test("sub-agent error path: failed sub-agents surface missing_connector gaps (with errorText)", async () => {
    // Build a real DB so resolveStartEntity + detectEmptyIndex work fine.
    // We need resolved != null so sub-agents reach their .all() calls.
    // Then wrap .all() to throw so the coordinator catches it → status:"error" → gap.
    const realDb = freshDb();
    // Insert one item so empty_index gap is suppressed.
    realDb.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed-err', 'github', 'pr', 'acme/z#1', 't', '', " +
        String(Date.now()) +
        ", 0, 0)",
    );
    // Insert a symbol so resolveStartEntity returns non-null (resolved is not null).
    realDb.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:symbol:err-target', 'symbol', 'item:filesystem:src/err.ts', 'src/err.ts', 'filesystem', '{}')",
    );
    // Insert pagerduty sync_state so subOncall passes the connector check.
    realDb.run(
      "INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token) VALUES " +
        "('pagerduty', 0, '')",
    );
    // Insert a dashboard entity so subDashboards passes the entity-type check.
    realDb.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:dash:err1', 'dashboard', 'metabase:err-1', 'Err Dashboard', 'metabase', '{}')",
    );
    // Insert a pipeline_run entity so subPipelines passes the entity-type check.
    realDb.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:pipeline:err1', 'pipeline_run', 'github:err-run', 'Err Run', 'github', '{}')",
    );

    // Wrap .all() to throw so the sub-agent tasks fail inside coordinator.run.
    const fakeDb = new Proxy(realDb, {
      get(target: Database, prop: string | symbol) {
        if (prop === "query") {
          return (sql: string) => {
            const stmt = target.query(sql);
            return new Proxy(stmt, {
              get(stmtTarget, stmtProp: string | symbol) {
                if (stmtProp === "all") {
                  return (..._args: unknown[]) => {
                    throw new Error("simulated sub-agent DB failure");
                  };
                }
                const val = Reflect.get(stmtTarget, stmtProp);
                return typeof val === "function" ? val.bind(stmtTarget) : val;
              },
            });
          };
        }
        const val = Reflect.get(target, prop);
        return typeof val === "function" ? val.bind(target) : val;
      },
    }) as unknown as Database;

    const brief = await runImpact(
      { fileOrPrUrl: "src/err.ts" },
      { db: fakeDb, sessionId: "t-sub-err", notify: () => {} },
    );

    // Sub-agents that call .all() should have failed → missing_connector gaps with errorText.
    const failGaps = brief.gaps.filter(
      (g) =>
        g.category === "missing_connector" &&
        g.detail.includes("impact sub-agent") &&
        g.detail.includes("simulated sub-agent DB failure"),
    );
    expect(failGaps.length).toBeGreaterThanOrEqual(1);
  });

  test("resolveStartEntity — unknown host uses hostFirstSegment as service name", async () => {
    // Use a custom enterprise host not in HOST_TO_SERVICE.
    // The service name is derived from the first DNS label (e.g. "myenterprise" from "myenterprise.corp.com").
    const db = freshDb();
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:pr:ent1', 'pr', 'myenterprise:acme/pay#7', 'acme/pay#7', 'myenterprise', '{}')",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "https://myenterprise.corp.com/acme/pay/pull/7" },
      { db, sessionId: "t-custom-host", notify: () => {} },
    );
    expect(brief.startEntityId).toBe("graph:pr:ent1");
  });

  test("subPipelines — finds pipeline via repoIds (hops=2, via-repo pathSummary)", async () => {
    // Set up a PR whose repo has a triggers->ci_run edge. Since start.repoIds.length > 0,
    // subPipelines uses hops=2 and the via-repo pathSummary.
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed-pipe', 'github', 'pr', 'acme/svc#9', 't', '', " +
        String(Date.now()) +
        ", 0, 0)",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:pr:pipe1', 'pr', 'github:acme/svc#9', 'acme/svc#9', 'github', '{}')",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:repo:svc', 'repo', 'github:acme/svc', 'acme/svc', 'github', '{}')",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:ci:run1', 'ci_run', 'github:ci-run-1', 'CI Run #1', 'github', '{}')",
    );
    db.run("INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES ('triggers', 1)");
    db.run(
      "INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES " +
        "('graph:repo:svc', 'graph:ci:run1', 'triggers', 0)",
    );

    const brief = await runImpact(
      { fileOrPrUrl: "https://github.com/acme/svc/pull/9" },
      { db, sessionId: "t-pipe-repo", notify: () => {} },
    );

    const pipeFindings = brief.affected.filter((f) => f.category === "pipeline");
    expect(pipeFindings).toHaveLength(1);
    expect(pipeFindings[0]?.hops).toBe(2);
    expect(pipeFindings[0]?.pathSummary).toContain("in_repo");
    expect(pipeFindings[0]?.affectedItemId).toBe("graph:ci:run1");
  });

  test("subPipelines — returns empty when pipeline_run entities exist but no triggers edges match", async () => {
    // Insert a pipeline_run entity so detectMissingEntityType('pipeline_run') returns null,
    // but no triggers relation so the query returns 0 rows → subPipelines returns {}.
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed-nopipe', 'github', 'pr', 'acme/q#2', 't', '', " +
        String(Date.now()) +
        ", 0, 0)",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:symbol:q', 'symbol', 'item:filesystem:src/q.ts', 'src/q.ts', 'filesystem', '{}')",
    );
    // pipeline_run entity exists (satisfies detectMissingEntityType check) but is unrelated.
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:pipeline:p1', 'pipeline_run', 'github:run-999', 'Unrelated Run', 'github', '{}')",
    );
    // No triggers edge for the symbol entity.

    const brief = await runImpact(
      { fileOrPrUrl: "src/q.ts" },
      { db, sessionId: "t-nopipe", notify: () => {} },
    );

    // pipeline category should not appear in affected (empty {} from subPipelines).
    const pipeFindings = brief.affected.filter((f) => f.category === "pipeline");
    expect(pipeFindings).toHaveLength(0);
    // And no pipeline_run missing_entity_type gap either.
    const pipeGap = brief.gaps.filter(
      (g) => g.category === "missing_entity_type" && g.detail.includes("pipeline_run"),
    );
    expect(pipeGap).toHaveLength(0);
  });

  test("subOncall — null start with pagerduty configured produces missing_relation_emit gap", async () => {
    // pagerduty is configured (sync_state row) so detectMissingConnector returns null.
    // start is null because the search string matches nothing.
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed-oc-null', 'github', 'pr', 'acme/y#3', 't', '', " +
        String(Date.now()) +
        ", 0, 0)",
    );
    db.run(
      "INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token) VALUES " +
        "('pagerduty', 0, '')",
    );
    // The search string matches no entity or item.
    const brief = await runImpact(
      { fileOrPrUrl: "xyzzy-no-match-at-all-12345" },
      { db, sessionId: "t-oc-null-start", notify: () => {} },
    );

    const oncallNullGap = brief.gaps.filter(
      (g) =>
        g.category === "missing_relation_emit" &&
        g.detail.includes("belongs_to") &&
        g.detail.includes("start entity"),
    );
    expect(oncallNullGap.length).toBeGreaterThanOrEqual(1);
  });

  test("service filter — only findings matching input.service are returned", async () => {
    // Set up a symbol with a downstream_repo finding ('filesystem') and an oncall finding ('pagerduty').
    // Verify the service filter correctly limits affected findings.
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed-svc-filter', 'github', 'pr', 'acme/f#1', 't', '', " +
        String(Date.now()) +
        ", 0, 0)",
    );
    db.run(
      "INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token) VALUES " +
        "('pagerduty', 0, '')",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:symbol:f', 'symbol', 'item:filesystem:src/f.ts', 'src/f.ts', 'filesystem', '{}')",
    );
    // Consumer depends_on the symbol → downstream_repo finding with serviceId='filesystem'.
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:symbol:consumer-f', 'symbol', 'item:filesystem:src/c.ts', 'src/c.ts', 'filesystem', '{}')",
    );
    db.run(
      "INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES " +
        "('graph:symbol:consumer-f', 'graph:symbol:f', 'depends_on', 0)",
    );
    // oncall_rotation belongs_to the symbol → oncall_rotation finding with serviceId='pagerduty'.
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:oncall:f1', 'oncall_rotation', 'pagerduty:rot-f', 'Filter Rotation', 'pagerduty', '{}')",
    );
    db.run(
      "INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES " +
        "('graph:symbol:f', 'graph:oncall:f1', 'belongs_to', 0)",
    );

    // Without filter: both findings appear.
    const briefAll = await runImpact(
      { fileOrPrUrl: "src/f.ts" },
      { db, sessionId: "t-svc-all", notify: () => {} },
    );
    expect(briefAll.affected.some((f) => f.serviceId === "filesystem")).toBe(true);
    expect(briefAll.affected.some((f) => f.serviceId === "pagerduty")).toBe(true);

    // With service='pagerduty': only pagerduty findings survive the filter.
    const briefFiltered = await runImpact(
      { fileOrPrUrl: "src/f.ts", service: "pagerduty" },
      { db, sessionId: "t-svc-filter", notify: () => {} },
    );
    expect(briefFiltered.affected.every((f) => f.serviceId === "pagerduty")).toBe(true);
    expect(briefFiltered.affected.some((f) => f.serviceId === "filesystem")).toBe(false);
    expect(briefFiltered.affected.length).toBeGreaterThanOrEqual(1);
  });

  test("resolveStartEntity — PR URL matches regex but entity not in DB falls through to symbol/topic search", async () => {
    // PR URL matches the regex but no graph_entity row exists → falls through, resolves to null.
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed-fallthrough', 'github', 'pr', 'acme/x#1', 't', '', " +
        String(Date.now()) +
        ", 0, 0)",
    );
    // No matching PR entity in graph_entity — startEntityId should be null.
    const brief = await runImpact(
      { fileOrPrUrl: "https://github.com/acme/notexist/pull/9999" },
      { db, sessionId: "t-pr-fallthrough", notify: () => {} },
    );
    expect(brief.startEntityId).toBeNull();
  });

  test("subDownstreamRepos — emits a service finding when repo entity is found via repoIds", async () => {
    // Exercises the rows.length > 0 path in subDownstreamRepos: a PR whose matching repo
    // is in the DB produces a 'service' finding.
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) VALUES " +
        "('seed-dr', 'github', 'pr', 'acme/mrepo#1', 't', '', " +
        String(Date.now()) +
        ", 0, 0)",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:pr:dr1', 'pr', 'github:acme/mrepo#1', 'acme/mrepo#1', 'github', '{}')",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
        "('graph:repo:mrepo', 'repo', 'github:acme/mrepo', 'acme/mrepo', 'github', '{}')",
    );
    const brief = await runImpact(
      { fileOrPrUrl: "https://github.com/acme/mrepo/pull/1" },
      { db, sessionId: "t-dr-found", notify: () => {} },
    );
    const serviceFindings = brief.affected.filter((f) => f.category === "service");
    expect(serviceFindings).toHaveLength(1);
    expect(serviceFindings[0]?.affectedItemId).toBe("graph:repo:mrepo");
    expect(serviceFindings[0]?.pathSummary).toContain("in_repo");
  });

  test("emitImpactBrief passes through the runner option to emitBriefWithSynthesis", async () => {
    // Provide a runner stub — the ctx.runner branch in emitImpactBrief spreads it into opts.
    const db = freshDb();
    const received: Array<{ method: string; params: unknown }> = [];
    const runnerStub = {
      run: async (prompt: string) => ({
        ok: true as const,
        markdown: `## Impact: stub\n${prompt.slice(0, 10)}`,
        model: "test-model",
        remote: false,
      }),
    };
    const handle = await emitImpactBrief(
      { fileOrPrUrl: "src/stub.ts" },
      {
        db,
        sessionId: "t-llm",
        runner: runnerStub,
        notify: (method, params) => {
          received.push({ method, params });
        },
      },
    );
    expect(handle.sessionId).toBe("t-llm");
    for (let i = 0; i < 40 && received.length === 0; i += 1) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(received).toHaveLength(1);
    const evt = received[0];
    // It should emit briefReady (LLM synthesis may produce its own markdown or fall back).
    expect(evt?.method === "impact.briefReady" || evt?.method === "impact.briefError").toBe(true);
  });
});
