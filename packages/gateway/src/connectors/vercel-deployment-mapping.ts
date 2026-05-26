/**
 * Pure mapping from a Vercel `GET /v6/deployments` list element to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `vercel-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "vercel", type = "deployment"` rows — a single item type.
 * `external_id = <uid>` (verbatim). The conceptual item identity is
 * `vercel:deployment`; the `item.id` ends up `vercel:<uid>`. NOTE: the bare
 * `deployment` *column* value is shared with the CI/CD annotation pipeline, but
 * that pipeline keys its rows under the CI-provider `service` (`github-actions`
 * etc.), so the `(service, external_id)` unique key never collides with this
 * connector's `service = "vercel"` rows. The `deployment` type is
 * sparse/structured (uid, name, state, commit sha), so it stays on local
 * MiniLM embeddings — NOT added to `PROSE_HEAVY_TYPES`.
 *
 * IMPORTANT: Vercel's `created` is epoch MILLISECONDS (a number) — pass through
 * verbatim via `numberField`, NO `Date.parse`.
 *
 * Nested access (`creator`, `meta`) descends defensively with {@link asRecord}
 * so a missing sub-object yields nulls rather than throwing.
 */

import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface VercelMappingContext {
  readonly syncedAt: number;
}

export interface VercelMappedRow {
  readonly service: "vercel";
  readonly type: "deployment";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

/**
 * Build the canonical (user-facing) URL for a deployment. Prefers the
 * vercel.com dashboard `inspectorUrl`; else prepends `https://` to the bare
 * `*.vercel.app` host; else null.
 */
export function deploymentUrl(
  inspectorUrl: string | null,
  deployHost: string | null,
): string | null {
  if (inspectorUrl !== null && inspectorUrl !== "") {
    return inspectorUrl;
  }
  if (deployHost !== null && deployHost !== "") {
    return `https://${deployHost}`;
  }
  return null;
}

export function mapVercelDeploymentToItem(
  raw: unknown,
  ctx: VercelMappingContext,
): VercelMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const uid = stringField(row, "uid");
  if (uid === undefined || uid === "") {
    return null;
  }

  const name = stringField(row, "name") ?? null;
  // `readyState` is the live state; `state` is the (older) alias. Prefer
  // readyState, fall back to state.
  const state = stringField(row, "readyState") ?? stringField(row, "state") ?? null;
  const target = stringField(row, "target") ?? null;
  const deployHost = stringField(row, "url") ?? null;
  const inspectorUrl = stringField(row, "inspectorUrl") ?? null;
  // Vercel `created` is epoch ms — pass through, no Date.parse.
  const createdAt = numberField(row, "created") ?? null;

  const meta = asRecord(row["meta"]) ?? {};
  const commitSha = stringField(meta, "githubCommitSha") ?? null;
  const commitMessage = stringField(meta, "githubCommitMessage") ?? null;
  const commitRef = stringField(meta, "githubCommitRef") ?? null;
  const prId = stringField(meta, "githubPrId") ?? null;

  const creatorObj = asRecord(row["creator"]) ?? {};
  const creator = stringField(creatorObj, "username") ?? stringField(creatorObj, "email") ?? null;

  const canonicalUrl = deploymentUrl(inspectorUrl, deployHost);
  const title =
    name !== null && name !== "" ? `${name} — ${state ?? "unknown"}` : `Deployment ${uid}`;
  const bodyPreview = commitMessage ?? "";
  const modifiedAt = createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    uid,
    name,
    state,
    target,
    url: deployHost,
    inspector_url: inspectorUrl,
    commit_sha: commitSha,
    commit_message: commitMessage,
    commit_ref: commitRef,
    pr_id: prId,
    creator,
    created_at: createdAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "vercel",
    type: "deployment",
    externalId: uid,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
