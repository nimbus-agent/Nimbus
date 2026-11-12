import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { githubActionsRunMetadata } from "../connectors/github-actions-sync.ts";
import { extractPrMetadataForIndex } from "../connectors/github-sync.ts";
import { mapVercelDeploymentToItem } from "../connectors/vercel-deployment-mapping.ts";
import { annotateDeployment } from "../deployment/annotate.ts";
import { graphAnnotatedDeployment } from "../deployment/graph-annotated.ts";
import type { DeploymentProvider } from "../deployment/types.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { NO_INCIDENT_BINDINGS, type ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { deployedSha } from "./deployment-edges.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OTHER_SHA = "a1b2c3d9999999999999999999999999999999ff";
const REPO = "acme/payments";

const PAYMENTS: ServiceConfig = {
  serviceId: "payments",
  repos: [{ provider: "github", providerId: REPO }],
  pagerdutyServices: ["PSVC1"],
  deployWorkflowPattern: /^Deploy/,
  incidentWindowMinutes: 60,
  excludePrLabels: [],
  deployEnvironments: ["prod"],
  severityP1Aliases: [],
  ...NO_INCIDENT_BINDINGS,
};
const resolver = buildServiceIdentityResolver(new Map([["payments", PAYMENTS]]));

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function mergedPr(db: Database, sha: string, number = 7): void {
  upsertIndexedItem(
    db,
    {
      service: "github",
      type: "pr",
      externalId: `${REPO}#${String(number)}`,
      title: `PR ${String(number)}`,
      bodyPreview: "",
      modifiedAt: NOW,
      syncedAt: NOW,
      metadata: extractPrMetadataForIndex(
        REPO,
        {
          number,
          state: "closed",
          merged: true,
          merged_at: new Date(NOW).toISOString(),
          merge_commit_sha: sha,
        },
        NOW,
      ),
    },
    resolver,
  );
}

function ciRun(db: Database, runId: number, headSha: string): void {
  upsertIndexedItem(
    db,
    {
      service: "github_actions",
      type: "ci_run",
      externalId: `${REPO}#run-${String(runId)}`,
      title: `Run ${String(runId)}`,
      bodyPreview: "",
      modifiedAt: NOW,
      syncedAt: NOW,
      metadata: githubActionsRunMetadata(
        REPO,
        {
          id: runId,
          name: "Deploy",
          status: "completed",
          conclusion: "success",
          head_sha: headSha,
          head_branch: "main",
        },
        NOW,
      ),
    },
    resolver,
  );
}

function annotate(
  db: Database,
  over: { sha?: string; provider?: DeploymentProvider; run_id?: string | undefined } = {},
): string {
  const provider = over.provider ?? "github-actions";
  const res = annotateDeployment(
    db,
    {
      service: "payments",
      provider,
      environment: "prod",
      sha: over.sha ?? SHA,
      ref: "main",
      status: "success",
      started_at_ms: NOW,
      ...("run_id" in over
        ? over.run_id === undefined
          ? {}
          : { run_id: over.run_id }
        : { run_id: "7412" }),
    },
    NOW,
  );
  const itemId = `deployment:${res.external_id}`;
  graphAnnotatedDeployment(db, itemId, resolver);
  return itemId;
}

type Edge = { type: string; from: string; to: string };

function edges(db: Database, types: string[] = ["deployed", "built_by"]): Edge[] {
  return db
    .query(
      `SELECT r.type AS type, f.type || ':' || f.external_id AS "from", t.type || ':' || t.external_id AS "to"
         FROM graph_relation r
         JOIN graph_entity f ON f.id = r.from_id
         JOIN graph_entity t ON t.id = r.to_id
        WHERE r.type IN (${types.map(() => "?").join(",")})
        ORDER BY r.type, "from", "to"`,
    )
    .all(...types) as Edge[];
}

const DEP = (itemId: string): string => `deployment:${itemId}`;
const COMMIT = `commit:github:${SHA}`;
const RUN = `ci_run:github_actions:${REPO}#run-7412`;

describe("deployed and built_by edges", () => {
  test("a deployment synced after its commit and CI run links both", () => {
    const db = freshDb();
    mergedPr(db, SHA);
    ciRun(db, 7412, SHA);
    const id = annotate(db);
    expect(edges(db)).toEqual([
      { type: "built_by", from: DEP(id), to: RUN },
      { type: "deployed", from: DEP(id), to: COMMIT },
    ]);
  });

  test("the SAME edges appear when the order is reversed: deployment, then PR, then CI run", () => {
    const forward = freshDb();
    mergedPr(forward, SHA);
    ciRun(forward, 7412, SHA);
    annotate(forward);

    const db = freshDb();
    annotate(db);
    expect(edges(db)).toEqual([]);
    mergedPr(db, SHA);
    expect(edges(db).map((e) => e.type)).toEqual(["deployed"]);
    ciRun(db, 7412, SHA);
    expect(edges(db)).toEqual(edges(forward));
    expect(edges(db)).toHaveLength(2);
  });

  test("a 7-character deployed sha matching one commit links; matching two different commits links none", () => {
    const db = freshDb();
    mergedPr(db, SHA);
    annotate(db, { sha: SHA.slice(0, 7), run_id: undefined });
    expect(edges(db, ["deployed"])).toHaveLength(1);
    // A second commit sharing the 7-character prefix makes the short sha ambiguous: no claim.
    mergedPr(db, OTHER_SHA, 8);
    expect(edges(db, ["deployed"])).toEqual([]);
  });

  test("no run_id, or a provider with no usable run key, gets deployed only", () => {
    const noRun = freshDb();
    mergedPr(noRun, SHA);
    ciRun(noRun, 7412, SHA);
    annotate(noRun, { run_id: undefined });
    expect(edges(noRun).map((e) => e.type)).toEqual(["deployed"]);

    for (const provider of ["jenkins", "bitbucket", "other"] as const) {
      const db = freshDb();
      mergedPr(db, SHA);
      ciRun(db, 7412, SHA);
      annotate(db, { provider });
      expect(edges(db).map((e) => e.type)).toEqual(["deployed"]);
    }
  });

  test("a wrong head_sha yields no built_by, and a non-numeric run id never reaches a query", () => {
    const db = freshDb();
    mergedPr(db, SHA);
    ciRun(db, 7412, OTHER_SHA);
    annotate(db);
    expect(edges(db).map((e) => e.type)).toEqual(["deployed"]);
    const weird = freshDb();
    ciRun(weird, 7412, SHA);
    annotate(weird, { run_id: "7412%" });
    expect(edges(weird, ["built_by"])).toEqual([]);
  });

  test("re-syncing the commit (which clears its edges) restores deployed", () => {
    const db = freshDb();
    annotate(db);
    upsertIndexedItem(
      db,
      {
        service: "git",
        type: "git_commit",
        externalId: `repo:${SHA}`,
        title: "fix payments",
        bodyPreview: "",
        modifiedAt: NOW,
        syncedAt: NOW,
        metadata: { sha: SHA, repoRoot: "/work/payments" },
      },
      resolver,
    );
    expect(edges(db, ["deployed"]).map((e) => e.to)).toEqual([`commit:git:${SHA}`]);
    upsertIndexedItem(
      db,
      {
        service: "git",
        type: "git_commit",
        externalId: `repo:${SHA}`,
        title: "fix payments (amended title)",
        bodyPreview: "",
        modifiedAt: NOW + 1,
        syncedAt: NOW + 1,
        metadata: { sha: SHA, repoRoot: "/work/payments" },
      },
      resolver,
    );
    expect(edges(db, ["deployed"])).toHaveLength(1);
  });

  test("re-syncing the deployment with a different sha retires the old deployed edge", () => {
    const db = freshDb();
    mergedPr(db, SHA);
    const id = annotate(db);
    expect(edges(db, ["deployed"])).toHaveLength(1);
    const row = db.query("SELECT metadata FROM item WHERE id = ?").get(id) as { metadata: string };
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    db.run("UPDATE item SET metadata = ? WHERE id = ?", [
      JSON.stringify({ ...meta, sha: OTHER_SHA }),
      id,
    ]);
    graphAnnotatedDeployment(db, id, resolver);
    expect(edges(db, ["deployed"])).toEqual([]);
  });

  test("a Vercel deployment (commit_sha, not in deployment_items) links forward only", () => {
    const vercel = (db: Database): void => {
      const row = mapVercelDeploymentToItem(
        {
          uid: "dpl_1",
          name: "payments",
          url: "payments.vercel.app",
          state: "READY",
          target: "production",
          created: NOW,
          meta: { githubCommitSha: SHA, githubRepo: "payments", githubOrg: "acme" },
        },
        { syncedAt: NOW },
      );
      if (row === null) throw new Error("vercel did not map");
      upsertIndexedItem(db, { ...row, metadata: { ...row.metadata, commit_sha: SHA } }, resolver);
    };
    const first = freshDb();
    mergedPr(first, SHA);
    vercel(first);
    expect(edges(first, ["deployed"])).toHaveLength(1);
    const later = freshDb();
    vercel(later);
    mergedPr(later, SHA);
    expect(edges(later, ["deployed"])).toEqual([]);
  });

  test("the reverse query uses idx_deployment_items_sha", () => {
    const db = freshDb();
    const plan = db
      .query(
        `EXPLAIN QUERY PLAN SELECT i.id FROM deployment_items d JOIN item i ON i.id = d.id WHERE d.sha IN (?, ?, ?)`,
      )
      .all("a", "b", "c") as { detail: string }[];
    expect(plan.map((p) => p.detail).join("\n")).toContain("idx_deployment_items_sha");
  });
});

describe("deployedSha", () => {
  test("reads sha, then commit_sha, lower-cased, and refuses anything that is not 7..64 hex", () => {
    expect(deployedSha({ sha: "ABCDEF1" })).toBe("abcdef1");
    expect(deployedSha({ commit_sha: SHA })).toBe(SHA);
    expect(deployedSha({ sha: "abc12" })).toBeUndefined();
    expect(deployedSha({ sha: "g".repeat(10) })).toBeUndefined();
    expect(deployedSha({ sha: `${SHA}${SHA}` })).toBeUndefined();
    expect(deployedSha({ sha: 5 })).toBeUndefined();
    expect(deployedSha({})).toBeUndefined();
  });
});
