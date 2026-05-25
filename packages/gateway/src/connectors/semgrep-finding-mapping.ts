/**
 * Pure mapping from a Semgrep AppSec Platform finding payload to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `semgrep-sync.ts` so the HTTP path and the indexing path can be
 * tested independently.
 *
 * Semgrep's findings envelope is documented at
 * https://semgrep.dev/api/v1/docs/. The fields surfaced into
 * `metadata` are the ones the Phase 5 roadmap row for `sast_finding`
 * calls out: severity, confidence, rule_name, rule_message, file_path,
 * line, repository — plus a couple of joins (`triage_state`, `status`,
 * `categories`) that downstream `nimbus query` predicates need.
 */

import { asRecord, stringField } from "./unknown-record.ts";

type Severity = "critical" | "high" | "medium" | "low" | "info";
const SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low", "info"]);

type Confidence = "high" | "medium" | "low";
const CONFIDENCES: ReadonlySet<string> = new Set(["high", "medium", "low"]);

type TriageState = "untriaged" | "triaged" | "ignored" | "muted";
const TRIAGE_STATES: ReadonlySet<string> = new Set(["untriaged", "triaged", "ignored", "muted"]);

type FindingStatus = "open" | "fixed" | "removed" | "ignored";
const STATUSES: ReadonlySet<string> = new Set(["open", "fixed", "removed", "ignored"]);

export interface SemgrepMappingContext {
  /** Deployment slug — used to construct canonical finding URLs. */
  readonly deploymentSlug: string;
  readonly syncedAt: number;
}

export interface SemgrepMappedRow {
  readonly service: "semgrep";
  readonly type: "finding";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

export function findingUrl(deploymentSlug: string, findingId: string): string {
  return `https://semgrep.dev/orgs/${encodeURIComponent(deploymentSlug)}/findings/${encodeURIComponent(findingId)}`;
}

function lowerEnum<T extends string>(value: unknown, set: ReadonlySet<string>): T | null {
  if (typeof value !== "string") {
    return null;
  }
  const lc = value.toLowerCase();
  return set.has(lc) ? (lc as T) : null;
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

function findingIdFrom(row: Record<string, unknown>): string | undefined {
  // Semgrep's API has emitted both `id` (legacy) and `syntactic_id`
  // (current canonical) across rev bumps. Either is acceptable as a
  // stable per-finding external id.
  return stringField(row, "id") ?? stringField(row, "syntactic_id");
}

export function mapSemgrepFindingToItem(
  raw: unknown,
  ctx: SemgrepMappingContext,
): SemgrepMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const id = findingIdFrom(row);
  if (id === undefined || id === "") {
    return null;
  }

  const ruleName = stringField(row, "rule_name") ?? id;
  const ruleMessage = stringField(row, "rule_message") ?? ruleName;
  const severity = lowerEnum<Severity>(row["severity"], SEVERITIES);
  const confidence = lowerEnum<Confidence>(row["confidence"], CONFIDENCES);
  const triageState = lowerEnum<TriageState>(row["triage_state"], TRIAGE_STATES);
  const status = lowerEnum<FindingStatus>(row["status"], STATUSES);
  const categories = pickStringArray(row["categories"]);

  const location = asRecord(row["location"]) ?? {};
  const filePath = stringField(location, "file_path") ?? null;
  const line = pickIntField(location, "line");
  const endLine = pickIntField(location, "end_line");
  const column = pickIntField(location, "column");

  const repository = asRecord(row["repository"]) ?? {};
  const repoName = stringField(repository, "name") ?? null;
  const repoUrl = stringField(repository, "url") ?? null;

  const branch = stringField(row, "ref") ?? stringField(row, "found_in_branch") ?? null;
  const lineOfCodeUrl = stringField(row, "line_of_code_url") ?? null;
  const createdAt = stringField(row, "created_at") ?? null;
  const relevantSince = stringField(row, "relevant_since") ?? null;
  const modifiedAt = parseIsoMs(relevantSince) ?? parseIsoMs(createdAt) ?? ctx.syncedAt;

  const canonicalUrl = findingUrl(ctx.deploymentSlug, id);

  const metadata: Record<string, unknown> = {
    severity,
    confidence,
    rule_name: ruleName,
    rule_message: ruleMessage,
    categories,
    file_path: filePath,
    line,
    end_line: endLine,
    column,
    repository: repoName,
    repository_url: repoUrl,
    branch,
    triage_state: triageState,
    status,
    deployment_slug: ctx.deploymentSlug,
    created_at: createdAt,
    relevant_since: relevantSince,
    line_of_code_url: lineOfCodeUrl,
  };

  return {
    service: "semgrep",
    type: "finding",
    externalId: id,
    title: ruleMessage,
    bodyPreview: ruleMessage,
    url: lineOfCodeUrl ?? canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
