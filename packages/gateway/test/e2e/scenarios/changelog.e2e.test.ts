import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { emitChangelogBrief } from "../../../src/agents/changelog.ts";
import { itemPrimaryKey } from "../../../src/index/item-key.ts";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";

const NOW = Date.now();
const DAY = 86_400_000;

/**
 * The REAL migrated schema, exactly as `expert.e2e.test.ts` builds it — `deployment_items` (V28)
 * only exists on it, and `selectDeployments` JOINs that table, so a hand-written `item`-only
 * schema would throw rather than proving what this test claims.
 */
function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/** One row per category, so all four sections render with a real entry rather than the
 * `_None in this window._` placeholder — closer to what a real weekly changelog looks like. */
function seedOneOfEach(db: Database): void {
  // Merged PR — windows on `metadata.merged_at`, the real event field GitHub writes.
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/payments#900",
    title: "Ship faster retry backoff",
    modifiedAt: NOW - DAY,
    syncedAt: NOW,
    metadata: { merged_at: NOW - DAY, repo: "acme/payments" },
  });

  // Annotated deployment — an `item` row of type `deployment` plus its `deployment_items`
  // shadow row, exactly as `deployment/annotate.ts` writes a real `POST /v1/deployments` call.
  const deployService = "github_actions";
  const deployExternalId = "deploy-001";
  upsertIndexedItem(db, {
    service: deployService,
    type: "deployment",
    externalId: deployExternalId,
    title: "Deploy payments-api",
    modifiedAt: NOW - DAY,
    syncedAt: NOW,
    metadata: {},
  });
  const deployItemId = itemPrimaryKey(deployService, deployExternalId);
  db.run(
    `INSERT INTO deployment_items
       (id, provider, nimbus_service_id, environment, sha, ref, started_at_ms, finished_at_ms,
        conclusion, created_at)
     VALUES (?, 'github-actions', 'payments', 'prod', 'abc123', 'main', ?, ?, 'success', ?)`,
    [deployItemId, NOW - DAY - 60_000, NOW - DAY, NOW],
  );

  // Incident opened — windows on `metadata.opened_at_ms`, still open (not resolved).
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-1",
    title: "Elevated 5xx on checkout",
    modifiedAt: NOW - DAY,
    syncedAt: NOW,
    metadata: { opened_at_ms: NOW - DAY, status: "triggered", pagerduty_service_id: "PD1" },
  });

  // Incident resolved — windows on `modified_at` with `metadata.status === "resolved"`.
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-2",
    title: "Database failover completed",
    modifiedAt: NOW - DAY,
    syncedAt: NOW,
    metadata: { status: "resolved", opened_at_ms: NOW - 2 * DAY, pagerduty_service_id: "PD1" },
  });
}

describe("nimbus changelog (e2e, in-process)", () => {
  test("seeded index -> brief: all four category headings + Gaps render; briefReady fires with non-empty brief and findings; zero HITL side-channel notifications", async () => {
    const db = freshDb();
    seedOneOfEach(db);

    const seen: Array<{ method: string; params: unknown }> = [];
    const result = await emitChangelogBrief({
      db,
      sessionId: "e2e-changelog-1",
      lookbackMs: 7 * DAY,
      service: null,
      serviceConfigs: [],
      notify: (method, params) => seen.push({ method, params }),
    });
    expect(result).toEqual({ sessionId: "e2e-changelog-1" });

    // Poll to a terminal notification rather than a fixed sleep — `emitChangelogBrief` is
    // fire-and-forget, and a fixed wait is the classic CI flake on a slow runner (see
    // `ownership.e2e.test.ts` for the same pattern).
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      if (
        seen.some((s) => s.method === "changelog.briefReady" || s.method === "changelog.briefError")
      ) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    // Zero HITL, proven at runtime: `emitBriefWithSynthesis` calls `notify` exactly once, for the
    // brief lifecycle event, never for a consent/HITL side channel. If `changelog` were ever
    // changed to route through the executor gate, a pending-consent notification would show up
    // here alongside (or instead of) `changelog.briefReady`, and this exact-equality would fail.
    expect(seen.map((s) => s.method)).toEqual(["changelog.briefReady"]);

    const ready = seen.find((s) => s.method === "changelog.briefReady");
    expect(ready).toBeDefined();
    const params = ready?.params as { brief: string; findings: { kind: string; gaps: unknown[] } };

    expect(params.brief.length).toBeGreaterThan(0);
    expect(params.findings.kind).toBe("changelog");
    expect(params.findings.gaps.length).toBeGreaterThan(0);

    // All four category headings, plus the reserved `## Gaps` section every brief carries — the
    // unconditional "dependency updates/config changes are not indexed" gap guarantees the
    // section is never empty (`agents/changelog.ts`'s `buildChangelogBrief`).
    for (const heading of [
      "## Merged Pull Requests",
      "## Deployments",
      "## Incidents Opened",
      "## Incidents Resolved",
      "## Gaps",
    ]) {
      expect(params.brief).toContain(heading);
    }
  });

  test("zero HITL actions fired (structural)", () => {
    const source = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../src/agents/changelog.ts"),
      "utf8",
    ) as string;
    expect(source).not.toContain("ToolExecutor");
    expect(source).not.toContain("HITL_REQUIRED");
  });
});
