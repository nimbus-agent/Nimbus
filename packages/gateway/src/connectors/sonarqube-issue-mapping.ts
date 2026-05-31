import { asRecord, stringField } from "./unknown-record.ts";

type Severity = "BLOCKER" | "CRITICAL" | "MAJOR" | "MINOR" | "INFO";
const SEVERITIES: ReadonlySet<string> = new Set(["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"]);

type IssueType = "BUG" | "VULNERABILITY" | "CODE_SMELL";
const ISSUE_TYPES: ReadonlySet<string> = new Set(["BUG", "VULNERABILITY", "CODE_SMELL"]);

type IssueStatus = "OPEN" | "CONFIRMED" | "REOPENED" | "RESOLVED" | "CLOSED";
const ISSUE_STATUSES: ReadonlySet<string> = new Set([
  "OPEN",
  "CONFIRMED",
  "REOPENED",
  "RESOLVED",
  "CLOSED",
]);

export interface SonarMappingContext {
  readonly baseUrl: string;
  readonly organization: string;
  readonly syncedAt: number;
}

export interface SonarMappedRow {
  readonly service: "sonarqube";
  readonly type: "code_issue";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.codePointAt(end - 1) === 47) end -= 1;
  return s.slice(0, end);
}

export function issueUrl(baseUrl: string, organization: string, issueKey: string): string {
  const base = stripTrailingSlashes(baseUrl);
  if (organization !== "") {
    return `${base}/project/issues?id=${encodeURIComponent(organization)}&issues=${encodeURIComponent(issueKey)}&open=${encodeURIComponent(issueKey)}`;
  }
  return `${base}/project/issues?issues=${encodeURIComponent(issueKey)}&open=${encodeURIComponent(issueKey)}`;
}

function pickSeverity(value: unknown): Severity | null {
  if (typeof value !== "string") {
    return null;
  }
  return SEVERITIES.has(value) ? (value as Severity) : null;
}

function pickIssueType(value: unknown): IssueType | null {
  if (typeof value !== "string") {
    return null;
  }
  return ISSUE_TYPES.has(value) ? (value as IssueType) : null;
}

function pickIssueStatus(value: unknown): IssueStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  return ISSUE_STATUSES.has(value) ? (value as IssueStatus) : null;
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

function pickIntField(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function extractFilePath(component: string): string | null {
  const idx = component.indexOf(":");
  if (idx < 0 || idx === component.length - 1) {
    return null;
  }
  return component.slice(idx + 1);
}

export function mapSonarIssueToItem(raw: unknown, ctx: SonarMappingContext): SonarMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const key = stringField(row, "key");
  if (key === undefined || key === "") {
    return null;
  }

  const message = stringField(row, "message") ?? key;
  const rule = stringField(row, "rule") ?? null;
  const component = stringField(row, "component") ?? "";
  const projectKey = stringField(row, "project") ?? "";
  const severity = pickSeverity(row["severity"]);
  const issueType = pickIssueType(row["type"]);
  const status = pickIssueStatus(row["status"]);
  const tags = pickStringArray(row["tags"]);
  const effort = stringField(row, "effort") ?? null;
  const debt = stringField(row, "debt") ?? null;
  const author = stringField(row, "author") ?? null;
  const line = pickIntField(row, "line");
  const filePath = extractFilePath(component);

  const creationDate = stringField(row, "creationDate") ?? null;
  const updateDate = stringField(row, "updateDate") ?? null;
  const modifiedAt = parseIsoMs(updateDate) ?? parseIsoMs(creationDate) ?? ctx.syncedAt;

  const canonicalUrl = issueUrl(ctx.baseUrl, ctx.organization, key);

  const metadata: Record<string, unknown> = {
    severity,
    type: issueType,
    status,
    rule,
    component,
    project_key: projectKey,
    file_path: filePath,
    line,
    tags,
    effort,
    debt,
    author,
    message,
    creation_date: creationDate,
    update_date: updateDate,
    canonical_url: canonicalUrl,
    organization: ctx.organization === "" ? null : ctx.organization,
  };

  return {
    service: "sonarqube",
    type: "code_issue",
    externalId: key,
    title: message,
    bodyPreview: message,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
