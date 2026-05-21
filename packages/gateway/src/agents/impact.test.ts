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
});
