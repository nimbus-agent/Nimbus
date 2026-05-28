import { asRecord, stringField } from "./unknown-record.ts";

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL";
const SEVERITIES: ReadonlySet<string> = new Set([
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFORMATIONAL",
]);

type Status = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "REJECTED";
const STATUSES: ReadonlySet<string> = new Set(["OPEN", "IN_PROGRESS", "RESOLVED", "REJECTED"]);

export interface WizMappingContext {
  readonly apiBaseUrl: string;
  readonly syncedAt: number;
}

export interface WizMappedRow {
  readonly service: "wiz";
  readonly type: "issue";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

export function issueUrl(apiBaseUrl: string, issueId: string): string {
  try {
    const u = new URL(apiBaseUrl);
    const host = u.hostname.startsWith("api.") ? u.hostname.slice(4) : u.hostname;
    return `${u.protocol}//${host}/issues#~(issue~'${encodeURIComponent(issueId)})`;
  } catch {
    return `${apiBaseUrl}#issue=${encodeURIComponent(issueId)}`;
  }
}

function pickEnum<T extends string>(value: unknown, set: ReadonlySet<string>): T | null {
  if (typeof value !== "string") {
    return null;
  }
  return set.has(value) ? (value as T) : null;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

interface ProjectRef {
  readonly id: string;
  readonly name: string;
}

function extractProjects(value: unknown): ProjectRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ProjectRef[] = [];
  for (const p of value) {
    const row = asRecord(p);
    if (row === undefined) {
      continue;
    }
    const id = stringField(row, "id");
    if (id === undefined || id === "") {
      continue;
    }
    out.push({ id, name: stringField(row, "name") ?? id });
  }
  return out;
}

export function mapWizIssueToItem(raw: unknown, ctx: WizMappingContext): WizMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const sourceRule = asRecord(row["sourceRule"]) ?? {};
  const sourceRuleId = stringField(sourceRule, "id") ?? null;
  const sourceRuleName = stringField(sourceRule, "name") ?? null;

  const entity = asRecord(row["entity"]) ?? {};
  const entityId = stringField(entity, "id") ?? null;
  const entityName = stringField(entity, "name") ?? null;
  const entityType = stringField(entity, "type") ?? null;

  const projects = extractProjects(row["projects"]);

  const severity = pickEnum<Severity>(row["severity"], SEVERITIES);
  const status = pickEnum<Status>(row["status"], STATUSES);
  const issueType = stringField(row, "type") ?? null;
  const description = stringField(row, "description") ?? null;
  const remediation = stringField(row, "remediation") ?? null;
  const createdAt = stringField(row, "createdAt") ?? null;
  const updatedAt = stringField(row, "updatedAt") ?? null;
  const resolvedAt = stringField(row, "resolvedAt") ?? null;
  const modifiedAt = parseIsoMs(updatedAt) ?? parseIsoMs(createdAt) ?? ctx.syncedAt;

  const canonicalUrl = issueUrl(ctx.apiBaseUrl, id);
  const title = sourceRuleName ?? id;
  const bodyPreview = description ?? title;

  const metadata: Record<string, unknown> = {
    severity,
    status,
    type: issueType,
    source_rule_id: sourceRuleId,
    source_rule_name: sourceRuleName,
    entity_id: entityId,
    entity_name: entityName,
    entity_type: entityType,
    project_ids: projects.map((p) => p.id),
    project_names: projects.map((p) => p.name),
    description,
    remediation,
    created_at: createdAt,
    updated_at: updatedAt,
    resolved_at: resolvedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "wiz",
    type: "issue",
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
