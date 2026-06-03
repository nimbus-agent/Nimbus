import { asRecord, stringField } from "./unknown-record.ts";

export interface TestflightMappedRow {
  readonly service: "testflight";
  readonly type: "app" | "build";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

export interface TestflightBuildMappingContext {
  readonly appId: string;
  /** Human-readable app name (from `GET /v1/apps`), when known. */
  readonly appName: string | undefined;
  readonly syncedAt: number;
}

/** Parse an ISO-8601 timestamp to epoch-ms; null on absent/garbled input. */
function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function boolField(r: Record<string, unknown>, key: string): boolean | null {
  const v = r[key];
  return typeof v === "boolean" ? v : null;
}

/**
 * Map a JSON:API `data[]` app resource (`GET /v1/apps`) to an indexed item.
 * `external_id` = the app `id`; canonical URL is null (no stable public URL).
 */
export function mapTestflightAppToItem(raw: unknown, syncedAt: number): TestflightMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return null;
  }
  const attributes = asRecord(row["attributes"]) ?? {};
  const name = stringField(attributes, "name");
  const bundleId = stringField(attributes, "bundleId");
  const sku = stringField(attributes, "sku");
  const title = name ?? bundleId ?? id;

  const metadata: Record<string, unknown> = {
    name: name ?? null,
    bundle_id: bundleId ?? null,
    sku: sku ?? null,
  };

  return {
    service: "testflight",
    type: "app",
    externalId: id,
    title,
    bodyPreview: bundleId !== undefined && bundleId !== "" ? `${title} (${bundleId})` : title,
    url: null,
    canonicalUrl: null,
    modifiedAt: syncedAt,
    metadata,
    syncedAt,
  };
}

function buildTitle(
  appName: string | undefined,
  version: string | undefined,
  processingState: string | undefined,
): string {
  const parts: string[] = [];
  if (appName !== undefined && appName !== "") {
    parts.push(appName);
  }
  parts.push(`#${version !== undefined && version !== "" ? version : "?"}`);
  if (processingState !== undefined && processingState !== "") {
    parts.push(`(${processingState})`);
  }
  return parts.join(" ");
}

/**
 * Map a JSON:API `data[]` build resource (`GET /v1/builds`) to an indexed item.
 * `external_id` = the build `id`; canonical URL is null (no stable public URL).
 */
export function mapTestflightBuildToItem(
  raw: unknown,
  ctx: TestflightBuildMappingContext,
): TestflightMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const buildId = stringField(row, "id");
  if (buildId === undefined || buildId === "") {
    return null;
  }
  const attributes = asRecord(row["attributes"]) ?? {};
  const version = stringField(attributes, "version");
  const processingState = stringField(attributes, "processingState");
  const minOsVersion = stringField(attributes, "minOsVersion");
  const usesNonExemptEncryption = boolField(attributes, "usesNonExemptEncryption");
  const expired = boolField(attributes, "expired");
  const uploadedMs = parseIsoMs(attributes["uploadedDate"]);

  const metadata: Record<string, unknown> = {
    app_id: ctx.appId,
    version: version ?? null,
    processing_state: processingState ?? null,
    expired,
    uploaded_date: uploadedMs,
    min_os_version: minOsVersion ?? null,
    uses_non_exempt_encryption: usesNonExemptEncryption,
  };

  const title = buildTitle(ctx.appName, version, processingState);

  return {
    service: "testflight",
    type: "build",
    externalId: buildId,
    title,
    bodyPreview: title,
    url: null,
    canonicalUrl: null,
    modifiedAt: uploadedMs ?? ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
