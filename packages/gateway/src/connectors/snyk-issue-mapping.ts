import { asRecord, stringField } from "./unknown-record.ts";

type Severity = "critical" | "high" | "medium" | "low";
const SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low"]);

export interface SnykMappingContext {
  readonly orgId: string;
  readonly projectId: string;
  readonly syncedAt: number;
}

export interface SnykMappedRow {
  readonly service: "snyk";
  readonly type: "vulnerability";
  readonly externalId: string;
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly canonicalUrl: string;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

export function projectUrl(orgId: string, projectId: string): string {
  return `https://app.snyk.io/org/${orgId}/project/${projectId}`;
}

function pickSeverity(value: unknown): Severity | null {
  if (typeof value !== "string") {
    return null;
  }
  return SEVERITIES.has(value) ? (value as Severity) : null;
}

function firstString(arr: unknown): string | null {
  if (!Array.isArray(arr)) {
    return null;
  }
  for (const v of arr) {
    if (typeof v === "string" && v !== "") {
      return v;
    }
  }
  return null;
}

function pickStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function mapSnykAggregatedIssueToItem(
  raw: unknown,
  ctx: SnykMappingContext,
): SnykMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const issueData = asRecord(row["issueData"]) ?? {};
  const fixInfo = asRecord(row["fixInfo"]) ?? {};
  const identifiers = asRecord(issueData["identifiers"]) ?? {};

  const title = stringField(issueData, "title") ?? id;
  const description = stringField(issueData, "description") ?? title;
  const url = stringField(issueData, "url") ?? null;
  const canonicalUrl = projectUrl(ctx.orgId, ctx.projectId);

  const disclosedAt = stringField(issueData, "disclosureTime") ?? null;
  const publishedAt = stringField(issueData, "publicationTime") ?? null;
  const modifiedAt = parseIsoMs(disclosedAt) ?? parseIsoMs(publishedAt) ?? ctx.syncedAt;

  const severity = pickSeverity(issueData["severity"]);
  const cveId = firstString(identifiers["CVE"]);
  const pkgName = stringField(row, "pkgName") ?? null;
  const pkgVersions = pickStringArray(row["pkgVersions"]);
  const fixable = fixInfo["isFixable"];
  const fixVersion = firstString(fixInfo["fixedIn"]);
  const issueType = stringField(row, "issueType") ?? null;

  const metadata: Record<string, unknown> = {
    severity,
    cve_id: cveId,
    affected_package: pkgName,
    affected_versions: pkgVersions,
    fix_available: typeof fixable === "boolean" ? fixable : fixVersion !== null,
    fix_version: fixVersion,
    project_id: ctx.projectId,
    org_id: ctx.orgId,
    project_url: canonicalUrl,
    type: issueType,
    disclosed_at: disclosedAt,
    published_at: publishedAt,
  };

  return {
    service: "snyk",
    type: "vulnerability",
    externalId: `${ctx.orgId}/${ctx.projectId}/${id}`,
    title,
    body: description,
    url,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
