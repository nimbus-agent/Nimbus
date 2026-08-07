import { itemPrimaryKey, upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import {
  type FetchOneResult,
  RateLimitError,
  retryAfterDateFromHeader,
  type Syncable,
  type SyncContext,
  type SyncResult,
  syncNoopResult,
  UnauthenticatedError,
} from "../sync/types.ts";
import {
  asRecord,
  basicAuthHeader,
  normalizeAtlassianSiteBaseUrl,
  stringField,
} from "./atlassian-api-sync-helpers.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "jira";
const CURSOR_PREFIX = "nimbus-jra1:";

type JiraSyncCursorV1 = { v: 1; floorJql: string | null };

function encodeCursor(c: JiraSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): JiraSyncCursorV1 | null {
  if (raw === null || raw === "") {
    return null;
  }
  const parsed = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (parsed === undefined) {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  if (rec["v"] !== 1) {
    return null;
  }
  const fj = rec["floorJql"];
  if (fj !== null && fj !== undefined && typeof fj !== "string") {
    return null;
  }
  return { v: 1, floorJql: typeof fj === "string" ? fj : null };
}

function isoToJqlExclusiveFloor(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) {
    return "1970/01/01 00:00";
  }
  d.setUTCSeconds(d.getUTCSeconds() + 1);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${String(y)}/${mo}/${da} ${h}:${mi}`;
}

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Full (untruncated) issue description text. Jira's `fields.description` is
 * either a plain string (classic REST v2 shape) or an Atlassian Document
 * Format object (REST v3); either way the caller passes the result through as
 * `body:`, so the store's own `clampBody`/`bodyCapForItemType` — not this
 * function — is the single place that applies a length cap.
 */
function descriptionText(fields: Record<string, unknown>): string {
  const d = fields["description"];
  if (d === null || d === undefined) {
    return "";
  }
  if (typeof d === "string") {
    return d;
  }
  try {
    return JSON.stringify(d);
  } catch {
    return "";
  }
}

type SearchEnvelope = {
  issues?: ReadonlyArray<Record<string, unknown>>;
  startAt?: number;
  maxResults?: number;
  total?: number;
};

type JiraVaultCreds = { token: string; email: string; baseUrl: string };

async function loadJiraVaultCreds(ctx: SyncContext): Promise<JiraVaultCreds | null> {
  const token = await readConnectorSecret(ctx.vault, "jira", "api_token");
  const email = await readConnectorSecret(ctx.vault, "jira", "email");
  const baseRaw = await readConnectorSecret(ctx.vault, "jira", "base_url");
  if (
    token === null ||
    token === "" ||
    email === null ||
    email === "" ||
    baseRaw === null ||
    baseRaw === ""
  ) {
    return null;
  }
  const baseUrl = normalizeAtlassianSiteBaseUrl(baseRaw);
  if (baseUrl === "") {
    return null;
  }
  return { token, email, baseUrl };
}

function jiraJqlFromCursor(prev: JiraSyncCursorV1 | null, initialSyncDepthDays: number): string {
  const hasFloor = prev?.floorJql !== null && prev?.floorJql !== undefined && prev.floorJql !== "";
  const jqlBase = hasFloor
    ? `updated > "${prev.floorJql}"`
    : `updated >= -${String(initialSyncDepthDays)}d`;
  return `${jqlBase} ORDER BY updated ASC`;
}

type JiraSearchPage = {
  issues: ReadonlyArray<Record<string, unknown>>;
  envelope: SearchEnvelope;
  text: string;
};

async function jiraFetchSearchPage(p: {
  ctx: SyncContext;
  creds: JiraVaultCreds;
  jql: string;
  startAt: number;
  pageSize: number;
}): Promise<JiraSearchPage> {
  const { ctx, creds, jql, startAt, pageSize } = p;
  const body = JSON.stringify({
    jql,
    startAt,
    maxResults: pageSize,
    fields: ["summary", "description", "updated", "issuetype", "status", "creator"],
  });
  const res = await fetch(`${creds.baseUrl}/rest/api/3/search`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: basicAuthHeader(creds.email, creds.token),
    },
    body,
  });
  const text = await res.text();

  if (res.status === 429) {
    const retryAt = retryAfterDateFromHeader(res.headers.get("retry-after"), 60);
    const ms = Math.max(1000, retryAt.getTime() - Date.now());
    ctx.rateLimiter.penalise("jira", ms);
    throw new RateLimitError(retryAt, "Jira sync: rate limited");
  }
  if (res.status === 401 || res.status === 403) {
    throw new UnauthenticatedError(`Jira sync HTTP ${String(res.status)}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Jira sync HTTP ${String(res.status)}: ${text.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Jira sync: invalid JSON");
  }
  const envelope = asRecord(parsed) as SearchEnvelope | undefined;
  const issues = envelope?.issues;
  if (issues === undefined || !Array.isArray(issues)) {
    throw new Error("Jira sync: missing issues array");
  }
  return { issues, envelope: envelope ?? {}, text };
}

function resolveJiraIssueAuthorId(
  ctx: SyncContext,
  accountId: string | undefined,
  creatorEmail: string | undefined,
  creatorName: string | undefined,
): string | null {
  if (accountId === undefined || accountId === "") {
    return null;
  }
  if (creatorEmail !== undefined && creatorEmail !== "") {
    return resolvePersonForSync(ctx.db, {
      jiraAccountId: accountId,
      canonicalEmail: creatorEmail,
      displayName: creatorName ?? creatorEmail,
    });
  }
  return resolvePersonForSync(ctx.db, {
    jiraAccountId: accountId,
    displayName: creatorName ?? accountId,
  });
}

function jiraIssueDerivedFromFields(
  fields: Record<string, unknown> | undefined,
  key: string,
  syncTime: number,
  maxUpdatedIso: { value: string },
): {
  summary: string;
  modified: number;
  bodyPrev: string;
  accountId: string | undefined;
  creatorEmail: string | undefined;
  creatorName: string | undefined;
} {
  let summary = key;
  if (fields !== undefined) {
    summary = stringField(fields, "summary") ?? key;
  }
  const updatedRaw = fields === undefined ? undefined : stringField(fields, "updated");
  const modified =
    updatedRaw === undefined || updatedRaw === "" ? syncTime : Date.parse(updatedRaw);
  if (updatedRaw !== undefined && updatedRaw !== "") {
    maxUpdatedIso.value =
      maxUpdatedIso.value === "" ? updatedRaw : maxIso(maxUpdatedIso.value, updatedRaw);
  }
  const bodyPrev = fields === undefined ? "" : descriptionText(fields);
  const creator = fields === undefined ? undefined : asRecord(fields["creator"]);
  return {
    summary,
    modified,
    bodyPrev,
    accountId: creator === undefined ? undefined : stringField(creator, "accountId"),
    creatorEmail: creator === undefined ? undefined : stringField(creator, "emailAddress"),
    creatorName: creator === undefined ? undefined : stringField(creator, "displayName"),
  };
}

function jiraIndexOneIssue(p: {
  ctx: SyncContext;
  issue: Record<string, unknown>;
  syncTime: number;
  baseUrl: string;
  maxUpdatedIso: { value: string };
}): boolean {
  const { ctx, issue: row, syncTime, baseUrl, maxUpdatedIso } = p;
  const key = stringField(row, "key");
  const id = stringField(row, "id");
  if (key === undefined || key === "") {
    return false;
  }
  const fields = asRecord(row["fields"]);
  const d = jiraIssueDerivedFromFields(fields, key, syncTime, maxUpdatedIso);
  const browseUrl = `${baseUrl}/browse/${key}`;
  const authorId = resolveJiraIssueAuthorId(ctx, d.accountId, d.creatorEmail, d.creatorName);
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "issue",
    externalId: key,
    title: d.summary.length > 512 ? d.summary.slice(0, 512) : d.summary,
    body: d.bodyPrev,
    url: browseUrl,
    canonicalUrl: browseUrl,
    modifiedAt: Number.isFinite(d.modified) ? d.modified : syncTime,
    authorId,
    metadata: { jiraId: id ?? key, key },
    pinned: false,
    syncedAt: syncTime,
  });
  return true;
}

function jiraShouldStopPaging(
  issuesLen: number,
  env: SearchEnvelope,
  startAtAfterIncrement: number,
  pageSize: number,
): boolean {
  if (issuesLen === 0) {
    return true;
  }
  const reportedTotal =
    typeof env.total === "number" && Number.isFinite(env.total) ? env.total : undefined;
  if (reportedTotal !== undefined) {
    return startAtAfterIncrement >= reportedTotal;
  }
  return issuesLen < pageSize;
}

/**
 * `<base>/browse/<KEY>-<N>` — emitted by both Cloud and Server/DC.
 *
 * Anchored at both ends and every quantifier bounded: the caller-supplied URL feeds an API path.
 */
export const JIRA_BROWSE_URL_RE = /^https?:\/\/[^/]+\/browse\/([A-Z][A-Z0-9_]{0,50}-\d{1,10})$/;

/**
 * A board/backlog deep link carrying `selectedIssue=<KEY>-<N>` in the query string. Deliberately
 * bounded on purpose: Jira's other shapes (agile boards, `/projects/X/issues/...`) vary too much
 * across Cloud and Server to support blind, and `unsupported_url` is what declining them is for —
 * this function does not guess a key from an arbitrary path.
 */
export const JIRA_SELECTED_ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{0,50}-\d{1,10}$/;

/**
 * Extracts an issue key from either supported shape, or returns `null` for anything else
 * (including an unparseable URL or a non-http(s) scheme).
 */
function jiraKeyFromUrl(url: string): string | null {
  const browseMatch = JIRA_BROWSE_URL_RE.exec(url);
  if (browseMatch !== null) {
    return browseMatch[1] as string;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const selected = parsed.searchParams.get("selectedIssue");
  if (selected !== null && JIRA_SELECTED_ISSUE_KEY_RE.test(selected)) {
    return selected;
  }
  return null;
}

/**
 * Fetch and index ONE Jira issue by its web URL. See `Syncable.fetchOne` for the contract: no
 * rate-limiter call, no egress append, no host-boundary check — those belong to the orchestrator
 * that calls this. This function's job is parse → call → map → upsert → return.
 */
async function fetchOneIssue(ctx: SyncContext, url: string): Promise<FetchOneResult> {
  const requestedKey = jiraKeyFromUrl(url);
  if (requestedKey === null) {
    return { status: "unsupported_url" };
  }
  const creds = await loadJiraVaultCreds(ctx);
  if (creds === null) {
    return { status: "not_found" };
  }
  const detailUrl = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(requestedKey)}`;
  const res = await fetch(detailUrl, {
    headers: {
      Accept: "application/json",
      Authorization: basicAuthHeader(creds.email, creds.token),
    },
  });
  if (!res.ok) {
    return { status: "not_found" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.text()) as unknown;
  } catch {
    return { status: "not_found" };
  }
  const issue = asRecord(parsed);
  if (issue === undefined) {
    return { status: "not_found" };
  }
  // The returned itemId MUST reflect the row `jiraIndexOneIssue` actually wrote, which keys off
  // the API response's own `key` field — never the raw regex capture from the caller's URL. A
  // Jira issue can be MOVED between projects, which changes its key; an old `/browse/` link then
  // 200s with the issue's CURRENT key, which can differ from the one in the URL.
  const returnedKey = stringField(issue, "key");
  if (returnedKey === undefined || returnedKey === "") {
    return { status: "not_found" };
  }
  const indexed = jiraIndexOneIssue({
    ctx,
    issue,
    syncTime: Date.now(),
    baseUrl: creds.baseUrl,
    maxUpdatedIso: { value: "" },
  });
  if (!indexed) {
    return { status: "not_found" };
  }
  return { status: "indexed", itemId: itemPrimaryKey(SERVICE_ID, returnedKey) };
}

export type JiraSyncableOptions = {
  ensureJiraMcpRunning: () => Promise<void>;
};

export function createJiraSyncable(options: JiraSyncableOptions): Syncable {
  const initialSyncDepthDays = 30;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 60 * 1000,
    initialSyncDepthDays,
    fetchOne: fetchOneIssue,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureJiraMcpRunning();
      const creds = await loadJiraVaultCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const prev = decodeCursor(cursor);
      const jql = jiraJqlFromCursor(prev, initialSyncDepthDays);

      await ctx.rateLimiter.acquire("jira");

      let startAt = 0;
      const pageSize = 50;
      let upserted = 0;
      let bytesTransferred = 0;
      const maxUpdatedIso = { value: "" };
      const syncTime = Date.now();

      for (;;) {
        const { issues, envelope, text } = await jiraFetchSearchPage({
          ctx,
          creds,
          jql,
          startAt,
          pageSize,
        });
        bytesTransferred += text.length;

        for (const issue of issues) {
          const row = asRecord(issue);
          if (row === undefined) {
            continue;
          }
          if (
            jiraIndexOneIssue({
              ctx,
              issue: row,
              syncTime,
              baseUrl: creds.baseUrl,
              maxUpdatedIso,
            })
          ) {
            upserted += 1;
          }
        }

        const nextStart = startAt + pageSize;
        if (jiraShouldStopPaging(issues.length, envelope, nextStart, pageSize)) {
          break;
        }
        startAt = nextStart;
      }

      const nextFloor =
        maxUpdatedIso.value === ""
          ? (prev?.floorJql ?? null)
          : isoToJqlExclusiveFloor(maxUpdatedIso.value);
      const nextCursor = encodeCursor({ v: 1, floorJql: nextFloor });

      return {
        cursor: nextCursor,
        itemsUpserted: upserted,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred,
      };
    },
  };
}
