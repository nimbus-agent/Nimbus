import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface VercelMappingContext {
  readonly syncedAt: number;
}

export type VercelMappedRow = MappedRow<"vercel", "deployment">;

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
  const state = stringField(row, "readyState") ?? stringField(row, "state") ?? null;
  const target = stringField(row, "target") ?? null;
  const deployHost = stringField(row, "url") ?? null;
  const inspectorUrl = stringField(row, "inspectorUrl") ?? null;
  const createdAt = numberField(row, "created") ?? null;

  const meta = asRecord(row["meta"]) ?? {};
  const commitSha = stringField(meta, "githubCommitSha") ?? null;
  const commitMessage = stringField(meta, "githubCommitMessage") ?? null;
  const commitRef = stringField(meta, "githubCommitRef") ?? null;
  const prId = stringField(meta, "githubPrId") ?? null;
  // Vercel's git-integration `meta` also carries the owning repo, under either the
  // top-level keys (githubOrg/githubRepo) or the commit-scoped ones
  // (githubCommitOrg/githubCommitRepo) depending on API version. Surfaced as
  // `repo` (the same key `graph-populator.ts` / `metrics/service-identity.ts`
  // already read off PR/issue/CI items) so a git-integrated Vercel deployment
  // can bind to a `[metrics.dora.<id>]`/`[ci.service.<id>]` repo URN.
  const githubOrg = stringField(meta, "githubOrg") ?? stringField(meta, "githubCommitOrg") ?? null;
  const githubRepo =
    stringField(meta, "githubRepo") ?? stringField(meta, "githubCommitRepo") ?? null;
  const repo = githubOrg !== null && githubRepo !== null ? `${githubOrg}/${githubRepo}` : null;

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
    repo,
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
