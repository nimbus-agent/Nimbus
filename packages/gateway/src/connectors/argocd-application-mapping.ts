import { trimTrailingSlash } from "./_lib/field-helpers.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface ArgocdMappingContext {
  readonly baseUrl: string;
  readonly syncedAt: number;
}

export type ArgocdMappedRow = MappedRow<"argocd", "application", string>;

export function applicationUrl(baseUrl: string, name: string): string {
  return `${trimTrailingSlash(baseUrl)}/applications/${encodeURIComponent(name)}`;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

/** How many deployment-history entries an indexed application keeps (Argo CD itself retains 10 by default). */
export const ARGOCD_HISTORY_KEEP = 20;

export type ArgocdHistoryEntry = {
  readonly id: number;
  readonly revision: string;
  readonly deployedAtMs: number | null;
};

/**
 * `status.history[]` as `{ id, revision, deployedAtMs }`, the newest (highest id) first, at most
 * {@link ARGOCD_HISTORY_KEEP}. An entry without an integer id or a string revision is skipped. Phase 10 IC5a: the
 * incident engine's rollback proposal reads it to find the entry that precedes the deploy that went wrong.
 */
export function argocdHistoryOf(status: Record<string, unknown>): ArgocdHistoryEntry[] {
  const raw = status["history"];
  if (!Array.isArray(raw)) return [];
  const out: ArgocdHistoryEntry[] = [];
  for (const e of raw as unknown[]) {
    const rec = asRecord(e);
    const id = rec?.["id"];
    const revision = rec === undefined ? undefined : stringField(rec, "revision");
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0) continue;
    if (revision === undefined || revision === "") continue;
    out.push({ id, revision, deployedAtMs: parseIsoMs(rec?.["deployedAt"]) });
  }
  out.sort((a, b) => b.id - a.id);
  return out.slice(0, ARGOCD_HISTORY_KEEP);
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
    history: argocdHistoryOf(status),
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
