import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface NetlifyMappingContext {
  readonly syncedAt: number;
}

export type NetlifyMappedRow = MappedRow<"netlify", "site">;

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

export function siteUrl(
  adminUrl: string | null,
  sslUrl: string | null,
  url: string | null,
): string | null {
  if (adminUrl !== null && adminUrl !== "") {
    return adminUrl;
  }
  if (sslUrl !== null && sslUrl !== "") {
    return sslUrl;
  }
  if (url !== null && url !== "") {
    return url;
  }
  return null;
}

export function mapNetlifySiteToItem(
  raw: unknown,
  ctx: NetlifyMappingContext,
): NetlifyMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const name = stringField(row, "name") ?? null;
  const url = stringField(row, "url") ?? null;
  const adminUrl = stringField(row, "admin_url") ?? null;
  const sslUrl = stringField(row, "ssl_url") ?? null;
  const accountName = stringField(row, "account_name") ?? null;
  const createdAt = parseIsoMs(row["created_at"]);
  const updatedAt = parseIsoMs(row["updated_at"]);

  const build = asRecord(row["build_settings"]) ?? {};
  const repoUrl = stringField(build, "repo_url") ?? null;
  const repoBranch = stringField(build, "repo_branch") ?? null;

  const deploy = asRecord(row["published_deploy"]) ?? {};
  const deployId = stringField(deploy, "id") ?? null;
  const deployState = stringField(deploy, "state") ?? null;
  const deployBranch = stringField(deploy, "branch") ?? null;
  const commitRef = stringField(deploy, "commit_ref") ?? null;
  const commitUrl = stringField(deploy, "commit_url") ?? null;
  const deployTitle = stringField(deploy, "title") ?? null;
  const deployUrl = stringField(deploy, "deploy_ssl_url") ?? null;

  const canonicalUrl = siteUrl(adminUrl, sslUrl, url);
  const title = name !== null && name !== "" ? name : `Site ${id}`;
  const bodyPreview = deployTitle ?? "";
  const modifiedAt = updatedAt ?? createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    site_id: id,
    name,
    url,
    admin_url: adminUrl,
    ssl_url: sslUrl,
    repo_url: repoUrl,
    repo_branch: repoBranch,
    deploy_state: deployState,
    deploy_id: deployId,
    deploy_branch: deployBranch,
    commit_ref: commitRef,
    commit_url: commitUrl,
    deploy_url: deployUrl,
    account_name: accountName,
    created_at: createdAt,
    updated_at: updatedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "netlify",
    type: "site",
    externalId: id,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
