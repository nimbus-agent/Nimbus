import { asRecord, stringField } from "./unknown-record.ts";

export interface ArgocdMappingContext {
  readonly baseUrl: string;
  readonly syncedAt: number;
}

export interface ArgocdMappedRow {
  readonly service: "argocd";
  readonly type: "application";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function applicationUrl(baseUrl: string, name: string): string {
  return `${trimTrailingSlash(baseUrl)}/applications/${encodeURIComponent(name)}`;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

export function mapArgocdApplicationToItem(
  raw: unknown,
  ctx: ArgocdMappingContext,
): ArgocdMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const meta = asRecord(row["metadata"]) ?? {};
  const name = stringField(meta, "name");
  if (name === undefined || name === "") {
    return null;
  }

  const spec = asRecord(row["spec"]) ?? {};
  const status = asRecord(row["status"]) ?? {};

  const namespace = stringField(meta, "namespace") ?? null;
  const createdAtMs = parseIsoMs(meta["creationTimestamp"]);

  const project = stringField(spec, "project") ?? null;

  const source = asRecord(spec["source"]) ?? {};
  const repoUrl = stringField(source, "repoURL") ?? null;
  const path = stringField(source, "path") ?? null;
  const targetRevision = stringField(source, "targetRevision") ?? null;

  const destination = asRecord(spec["destination"]) ?? {};
  const destServer = stringField(destination, "server") ?? null;
  const destNamespace = stringField(destination, "namespace") ?? null;

  const syncObj = asRecord(status["sync"]) ?? {};
  const syncStatus = stringField(syncObj, "status") ?? null;
  const revision = stringField(syncObj, "revision") ?? null;

  const healthObj = asRecord(status["health"]) ?? {};
  const healthStatus = stringField(healthObj, "status") ?? null;

  const modifiedAt = createdAtMs ?? ctx.syncedAt;
  const canonicalUrl = applicationUrl(ctx.baseUrl, name);
  const title = name;
  const bodyPreview = `${name} — ${syncStatus ?? "?"}/${healthStatus ?? "?"}`;

  const metadata: Record<string, unknown> = {
    name,
    namespace,
    project,
    sync_status: syncStatus,
    health_status: healthStatus,
    repo_url: repoUrl,
    path,
    target_revision: targetRevision,
    dest_server: destServer,
    dest_namespace: destNamespace,
    revision,
    created_at: createdAtMs,
    canonical_url: canonicalUrl,
  };

  return {
    service: "argocd",
    type: "application",
    externalId: name,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
