import { asRecord, stringField } from "./unknown-record.ts";

export interface FluxMappingContext {
  readonly kind: string;
  readonly syncedAt: number;
}

export interface FluxMappedRow {
  readonly service: "flux";
  readonly type: "resource";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

interface ReadyCondition {
  readonly status: string | null;
  readonly reason: string | null;
  readonly message: string | null;
  readonly lastTransitionTime: string | null;
}

function findReadyCondition(status: Record<string, unknown>): ReadyCondition | null {
  const conditions = status["conditions"];
  if (!Array.isArray(conditions)) {
    return null;
  }
  for (const entry of conditions) {
    const c = asRecord(entry);
    if (c === undefined) {
      continue;
    }
    if (stringField(c, "type") === "Ready") {
      return {
        status: stringField(c, "status") ?? null,
        reason: stringField(c, "reason") ?? null,
        message: stringField(c, "message") ?? null,
        lastTransitionTime: stringField(c, "lastTransitionTime") ?? null,
      };
    }
  }
  return null;
}

export function mapFluxResourceToItem(raw: unknown, ctx: FluxMappingContext): FluxMappedRow | null {
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

  const ready = findReadyCondition(status);
  const readyStatus = ready?.status ?? null;
  const readyReason = ready?.reason ?? null;
  const readyMessage = ready?.message ?? null;

  const suspend = spec["suspend"] === true;
  const url = stringField(spec, "url") ?? null;
  const path = stringField(spec, "path") ?? null;
  const lastAppliedRevision = stringField(status, "lastAppliedRevision") ?? null;
  const lastAttemptedRevision = stringField(status, "lastAttemptedRevision") ?? null;

  const nsLocator = namespace ?? "_";
  const canonicalUrl = `${ctx.kind}/${nsLocator}/${name}`;
  const externalId = `${ctx.kind}/${nsLocator}/${name}`;

  const modifiedAt = parseIsoMs(ready?.lastTransitionTime) ?? createdAtMs ?? ctx.syncedAt;
  const title = name;
  const bodyPreview = `${ctx.kind} ${nsLocator}/${name} — Ready=${readyStatus ?? "?"}`;

  const metadata: Record<string, unknown> = {
    kind: ctx.kind,
    name,
    namespace,
    ready_status: readyStatus,
    ready_reason: readyReason,
    ready_message: readyMessage,
    suspend,
    url,
    path,
    last_applied_revision: lastAppliedRevision,
    last_attempted_revision: lastAttemptedRevision,
    created_at: createdAtMs,
    canonical_url: canonicalUrl,
  };

  return {
    service: "flux",
    type: "resource",
    externalId,
    title,
    bodyPreview,
    url: null,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
