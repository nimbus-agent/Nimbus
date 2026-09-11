import { describe, expect, test } from "bun:test";
import {
  nonGithubMergedPrCount,
  selectDeployments,
  selectIncidentsOpened,
  selectMergedPrs,
} from "../../src/agents/changelog-queries.ts";
import { createMemoryIndexDb } from "../../src/connectors/connector-sync-test-helpers.ts";
import { DEFAULT_DEPLOY_WORKFLOW_PATTERN } from "../../src/metrics/dora-config.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
// ABSOLUTE bounds. `sinceMs` as an agent INPUT is a duration repo-wide; `Window` is not an input.
const W = { fromMs: NOW - 7 * DAY, toMs: NOW, scope: { kind: "all" as const } };

function insertItem(
  db: ReturnType<typeof createMemoryIndexDb>,
  row: {
    id: string;
    service: string;
    type: string;
    title: string;
    modifiedAt: number;
    meta: unknown;
  },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, metadata, synced_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      row.id,
      row.service,
      row.type,
      row.id,
      row.title,
      row.modifiedAt,
      JSON.stringify(row.meta),
      NOW,
    ],
  );
}

describe("changelog queries against the real migrated schema", () => {
  test("a merged PR inside the window is returned; one merged before it is not", () => {
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "github:1",
      service: "github",
      type: "pr",
      title: "In window",
      modifiedAt: NOW,
      meta: { merged_at: NOW - DAY },
    });
    insertItem(db, {
      id: "github:2",
      service: "github",
      type: "pr",
      title: "Too old",
      modifiedAt: NOW,
      meta: { merged_at: NOW - 30 * DAY },
    });

    const rows = selectMergedPrs(db, W);
    expect(rows.map((r) => r.title)).toEqual(["In window"]);
    expect(rows[0]?.timeSource).toBe("event");
  });

  test("an OPEN PR is excluded even though modified_at is inside the window", () => {
    // The whole point of event-time windowing: modified_at says "touched", not "merged".
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "github:3",
      service: "github",
      type: "pr",
      title: "Still open",
      modifiedAt: NOW - DAY,
      meta: { state: "open" },
    });
    expect(selectMergedPrs(db, W)).toEqual([]);
  });

  test("malformed metadata JSON does not throw", () => {
    // json_extract RAISES on malformed JSON in this position; json_valid must guard it.
    const db = createMemoryIndexDb();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES ('github:4','github','pr','4','Broken',?,'{not json',?)`,
      [NOW, NOW],
    );
    expect(() => selectMergedPrs(db, W)).not.toThrow();
  });

  test("the window is half-open: an event exactly at nowMs is excluded", () => {
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "github:5",
      service: "github",
      type: "pr",
      title: "On the edge",
      modifiedAt: NOW,
      meta: { merged_at: NOW },
    });
    expect(selectMergedPrs(db, W)).toEqual([]);
  });

  test("non-GitHub merged PRs are counted for disclosure, not silently dropped", () => {
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "gitlab:9",
      service: "gitlab",
      type: "pr",
      title: "Merged MR",
      modifiedAt: NOW - DAY,
      meta: { state: "merged" },
    });
    expect(selectMergedPrs(db, W)).toEqual([]);
    expect(nonGithubMergedPrCount(db, W)).toBe(1);
  });

  test("a successful CI run that is not a deploy is excluded", () => {
    // Counting every green ci_run would report "Run tests" and "Lint" as deployments.
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "gha:1",
      service: "github_actions",
      type: "ci_run",
      title: "Run tests",
      modifiedAt: NOW - DAY,
      meta: { conclusion: "success" },
    });
    insertItem(db, {
      id: "gha:2",
      service: "github_actions",
      type: "ci_run",
      title: "Deploy to prod",
      modifiedAt: NOW - DAY,
      meta: { conclusion: "success" },
    });

    const rows = selectDeployments(db, W, new RegExp(DEFAULT_DEPLOY_WORKFLOW_PATTERN));
    expect(rows.map((r) => r.title)).toEqual(["Deploy to prod"]);
  });

  test("an annotated deploy is timed from finished_at_ms, a real event time", () => {
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "dep:1",
      service: "github_actions",
      type: "deployment",
      title: "web",
      modifiedAt: NOW,
      meta: {},
    });
    db.run(
      `INSERT INTO deployment_items (id, provider, nimbus_service_id, environment, sha, ref,
        started_at_ms, finished_at_ms, conclusion, created_at)
       VALUES ('dep:1','github-actions','web','staging','abc','main',?,?,'success',?)`,
      [NOW - 2 * DAY, NOW - DAY, NOW],
    );

    const rows = selectDeployments(db, W, new RegExp(DEFAULT_DEPLOY_WORKFLOW_PATTERN));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.atMs).toBe(NOW - DAY);
    // A real column, not modified_at — so not an approximation.
    expect(rows[0]?.timeSource).toBe("event");
    // Staging counts: a changelog answers "what happened", and the environment is on the entry.
    expect(rows[0]?.title).toContain("staging");
  });

  test("an incident without opened_at_ms is excluded", () => {
    const db = createMemoryIndexDb();
    insertItem(db, {
      id: "pagerduty:1",
      service: "pagerduty",
      type: "incident",
      title: "No time",
      modifiedAt: NOW - DAY,
      meta: {},
    });
    expect(selectIncidentsOpened(db, W)).toEqual([]);
  });
});
