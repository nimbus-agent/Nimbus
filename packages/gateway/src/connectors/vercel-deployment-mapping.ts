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
