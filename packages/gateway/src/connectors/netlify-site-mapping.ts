/**
 * Pure mapping from a Netlify `GET /api/v1/sites` list element to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `netlify-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "netlify", type = "site"` rows — a single item type.
 * `external_id = <site id>` (verbatim). The conceptual item identity is
 * `netlify:site`; the `item.id` ends up `netlify:<siteId>`. The `site` type is
 * sparse/structured (id, name, URLs, deploy state, commit ref), so it stays on
 * local MiniLM embeddings — NOT added to `PROSE_HEAVY_TYPES`.
 *
 * IMPORTANT: Netlify timestamps are ISO-8601 STRINGS (e.g.
 * `"2024-03-01T12:00:00.000Z"`), UNLIKE Vercel's epoch-ms numbers. Parse them
 * to epoch-ms with {@link parseIsoMs} — never pass the ISO string through
 * verbatim.
 *
 * Nested access (`build_settings`, `published_deploy`) descends defensively
 * with {@link asRecord} so a missing sub-object yields nulls rather than
 * throwing.
 */

import { asRecord, stringField } from "./unknown-record.ts";

export interface NetlifyMappingContext {
  readonly syncedAt: number;
}

export interface NetlifyMappedRow {
  readonly service: "netlify";
  readonly type: "site";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

/**
 * Build the canonical (user-facing) URL for a site. Prefers the Netlify
 * dashboard `admin_url`; else the `ssl_url`; else the bare `url`; else null.
 */
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
