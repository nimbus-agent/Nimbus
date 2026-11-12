import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import {
  deterministicGraphEntityId,
  ensureGraphEntity,
  upsertGraphRelation,
} from "./relationship-graph.ts";

/**
 * The deployment's own edges to what it shipped and what built it (Phase 10 IC2, incident-engine spec
 * § 5.2): `deployment --deployed--> commit` and `deployment --built_by--> ci_run`. Both relation types are
 * owned by the DEPLOYMENT's side: they are not cross-item types, so the deployment's own sync clears and
 * re-emits them, and so does every relink below.
 *
 * Evidence is only what a deployment really carries:
 *  - the deployed sha (`metadata.sha` on a CI-annotated deployment, `metadata.commit_sha` on a Vercel one),
 *    7..64 hex characters, matched as a PREFIX of a `commit` entity's full sha;
 *  - for `built_by`, the provider's run token (`metadata.run_id`) and the same sha against a `ci_run`
 *    item's `head_sha` of the provider's CI service. `deployment_items.ci_run_external_id` is always NULL
 *    (`deployment/annotate.ts`), so it is not used.
 *
 * An edge is written only when the evidence is unambiguous: a short sha that matches two different full
 * shas gets no `deployed` edge, and a `ci_run` whose head sha differs gets no `built_by` edge. A wrong
 * guess yields no edge, never a wrong one. Jenkins, Bitbucket and `other` have no usable run key, and a
 * Vercel deployment is not in `deployment_items`, so each of those gets what its evidence supports.
 *
 * A CI run usually syncs AFTER the deploy step that annotated it, and a PR can sync after a deployment, so
 * forward-only linking would miss the common order. `relinkDeploymentsForCommit` and
 * `relinkDeploymentsForCiRun` find the deployments whose sha is a prefix of a newly seen commit or run and
 * rebuild their edges (an indexed equality probe on `idx_deployment_items_sha`, one select per call).
 */

const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
const RUN_ID_PATTERN = /^\d{1,20}$/;
const MIN_SHA = 7;
const MAX_SHA = 64;

/** A deployment provider's CI service and the suffix its run ids carry in a `ci_run` external id. */
const CI_BY_PROVIDER: Readonly<
  Record<string, { readonly service: string; readonly token: (runId: string) => string }>
> = Object.freeze({
  "github-actions": { service: "github_actions", token: (id) => `#run-${id}` },
  gitlab: { service: "gitlab", token: (id) => `#pipeline-${id}` },
  // UNVERIFIED: assumes the annotation's run_id is the pipeline NUMBER. The head-sha equality makes a wrong
  // guess produce no edge, never a wrong one.
  circleci: { service: "circleci", token: (id) => `#p${id}` },
});

export type DeploymentEdgeSource = {
  readonly id: string;
  readonly service: string;
  readonly metadata: Record<string, unknown>;
};

function metaString(meta: Record<string, unknown>, key: string): string | undefined {
  const v = meta[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** The deployed sha, lower-cased, when the deployment carries a usable one. */
export function deployedSha(meta: Record<string, unknown>): string | undefined {
  // lane-census: scope=deployment
  const raw = metaString(meta, "sha") ?? metaString(meta, "commit_sha");
  const sha = raw?.toLowerCase();
  return sha !== undefined && SHA_PATTERN.test(sha) ? sha : undefined;
}

type CommitMatch = { id: string; sha: string };

/** Every `commit` entity whose full sha starts with `sha`. */
function matchingCommits(db: Database, sha: string): CommitMatch[] {
  const rows = db
    .query(
      `SELECT id, substr(external_id, instr(external_id, ':') + 1) AS sha
         FROM graph_entity
        WHERE type = 'commit'
          AND substr(external_id, instr(external_id, ':') + 1) LIKE ? || '%'
        ORDER BY id ASC`,
    )
    .all(sha) as CommitMatch[];
  return rows.map((r) => ({ id: r.id, sha: r.sha.toLowerCase() }));
}

type CiRunRow = { id: string; title: string; service: string };

/** The newest `ci_run` of the provider's CI service for this run token whose head sha starts with `sha`. */
function findCiRun(db: Database, ciService: string, token: string, sha: string): CiRunRow | null {
  // lane-census: scope=ci_run service=github_actions,gitlab,circleci
  return db
    .query(
      `SELECT id, title, service
         FROM item
        WHERE type = 'ci_run'
          AND service = ?
          AND substr(external_id, -length(?)) = ?
          AND json_valid(metadata)
          AND lower(json_extract(metadata, '$.head_sha')) LIKE ? || '%'
        ORDER BY modified_at DESC, id ASC
        LIMIT 1`,
    )
    .get(ciService, token, token, sha) as CiRunRow | null;
}

function clearDeploymentEdges(db: Database, deploymentEntityId: string): void {
  dbRun(db, "DELETE FROM graph_relation WHERE from_id = ? AND type IN ('deployed', 'built_by')", [
    deploymentEntityId,
  ]);
}

/**
 * Rebuilds `deployed` and `built_by` for one deployment entity from its own metadata. Idempotent: the
 * existing edges of both types are retired first, so a changed sha, a newly ambiguous prefix or a run that
 * stopped matching leaves no stale edge, whichever side triggered the rebuild.
 */
export function linkDeploymentToChange(
  db: Database,
  source: DeploymentEdgeSource,
  deploymentEntityId: string,
  now: number,
): void {
  clearDeploymentEdges(db, deploymentEntityId);
  const sha = deployedSha(source.metadata);
  if (sha === undefined) return;

  const commits = matchingCommits(db, sha);
  // Exactly one distinct full sha, or no claim: a short prefix shared by two commits proves neither.
  const distinct = new Set(commits.map((c) => c.sha));
  if (distinct.size === 1) {
    for (const c of commits) upsertGraphRelation(db, deploymentEntityId, c.id, "deployed", now);
  }

  const ci = CI_BY_PROVIDER[source.service];
  const runId = metaString(source.metadata, "run_id");
  if (ci === undefined || runId === undefined || !RUN_ID_PATTERN.test(runId)) return;
  const run = findCiRun(db, ci.service, ci.token(runId), sha);
  if (run === null) return;
  const runEntityId = ensureGraphEntity(db, {
    type: "ci_run",
    externalId: run.id,
    label: run.title,
    service: run.service,
  });
  upsertGraphRelation(db, deploymentEntityId, runEntityId, "built_by", now);
}

type DeploymentRow = { id: string; service: string; metadata: string | null };

/** The sha prefixes of lengths 7..64 a deployment could have recorded for this full sha. */
function shaPrefixes(fullSha: string): string[] {
  const sha = fullSha.toLowerCase();
  if (!SHA_PATTERN.test(sha)) return [];
  const out: string[] = [];
  for (let len = MIN_SHA; len <= Math.min(MAX_SHA, sha.length); len += 1)
    out.push(sha.slice(0, len));
  return out;
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Rebuilds the edges of every CI-annotated deployment whose recorded sha is a prefix of `fullSha`, skipping
 * a deployment that has no graph entity yet (its own sync will link it). One indexed select per call
 * (`idx_deployment_items_sha`); the rebuild is per deployment, so ambiguity is judged afresh each time.
 */
function relinkDeploymentsBySha(db: Database, fullSha: string, now: number): void {
  const prefixes = shaPrefixes(fullSha);
  if (prefixes.length === 0) return;
  const placeholders = prefixes.map(() => "?").join(", ");
  const deployments = db
    .query(
      `SELECT i.id AS id, i.service AS service, i.metadata AS metadata
         FROM deployment_items d
         JOIN item i ON i.id = d.id
        WHERE d.sha IN (${placeholders})`,
    )
    .all(...prefixes) as DeploymentRow[];
  for (const d of deployments) {
    const entityId = deterministicGraphEntityId("deployment", d.id);
    const exists = db.query("SELECT 1 AS one FROM graph_entity WHERE id = ?").get(entityId);
    if (exists === null) continue;
    linkDeploymentToChange(
      db,
      { id: d.id, service: d.service, metadata: parseMeta(d.metadata) },
      entityId,
      now,
    );
  }
}

/** A `commit` entity was written or rebuilt: re-link the deployments that shipped it. */
export function relinkDeploymentsForCommit(db: Database, fullSha: string, now: number): void {
  relinkDeploymentsBySha(db, fullSha, now);
}

/** A `ci_run` item was written: re-link the deployments whose sha is a prefix of its head sha. */
export function relinkDeploymentsForCiRun(db: Database, headSha: unknown, now: number): void {
  if (typeof headSha === "string") relinkDeploymentsBySha(db, headSha, now);
}
