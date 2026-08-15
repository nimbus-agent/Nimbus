import { itemPrimaryKey, upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import {
  FETCH_ONE_TIMEOUT_MS,
  type FetchOneResult,
  RateLimitError,
  retryAfterDateFromHeader,
  type Syncable,
  type SyncContext,
  type SyncResult,
  syncNoopResult,
  UnauthenticatedError,
} from "../sync/types.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  asRecord,
  basicAuthHeader,
  normalizeAtlassianSiteBaseUrl,
  stringField,
} from "./atlassian-api-sync-helpers.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { fetchOneMissForResponse } from "./fetch-miss-reason.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { msFromIso, normalizeJiraStatusCategory, TICKET_META_VERSION } from "./ticket-depth.ts";

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

/**
 * Just the normalized `jira.base_url`, independent of the `email`/`api_token` credentials
 * `loadJiraVaultCreds` also requires. `sync/targeted-fetch.ts`'s pre-dispatch `urlIsSupported`
 * check (via `jiraFetchOneUrlIsSupported` below) needs ONLY this to decide whether `fetchOneIssue`
 * would accept a request's base — reading the other two secrets there too would be pointless
 * Vault traffic on every targeted-fetch request that never reaches `fetchOne`.
 */
export async function jiraConfiguredBaseUrl(vault: NimbusVault): Promise<string | null> {
  const baseRaw = await readConnectorSecret(vault, "jira", "base_url");
  if (baseRaw === null || baseRaw === "") {
    return null;
  }
  const baseUrl = normalizeAtlassianSiteBaseUrl(baseRaw);
  return baseUrl === "" ? null : baseUrl;
}

/**
 * Whether `basePath` (the configured base URL's `pathname`) is a genuine prefix of
 * `requestPath` — `/jira` matches `/jira` and `/jira/browse/ENG-1`, but never `/jiraxyz`. A root
 * base (`/`, the common no-context-path case) imposes no constraint: every request path is under
 * it.
 */
function pathIsUnderBase(basePath: string, requestPath: string): boolean {
  const trimmed = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  if (trimmed === "") {
    return true;
  }
  return requestPath === trimmed || requestPath.startsWith(`${trimmed}/`);
}

/**
 * Whether `url` — the caller's targeted-fetch request — actually belongs to the Jira instance
 * `configuredBaseUrl` (the normalized, Vault-configured `jira.base_url`) names: scheme, host,
 * port AND path prefix must all agree.
 *
 * The host boundary (`sync/fetch-host-boundary.ts`) proves only that the request's HOST is
 * claimed by Jira; it says nothing about scheme, port, or a context path
 * (`https://acme.atlassian.net/jira`). Without this check, a caller `/browse/` URL whose spelling
 * merely diverges from the configured base — most concretely, a context path the caller's URL
 * omits — would still dispatch, and `jiraIndexOneIssue` would write `resolve_key` under the
 * CONFIGURED base rather than the CALLER's URL: a stored key the caller's own link can never
 * resolve again, so a resolve-then-fetch client loops forever.
 *
 * Both sides are re-parsed with `new URL()` (never compared as raw strings) so a spelling variant
 * that collapses to the same origin under URL normalization — an explicit default port, a
 * trailing slash — is accepted rather than treated as a mismatch; in practice this rarely matters
 * for the port/slash cases specifically, since `index/item-store.ts`'s `upsertIndexedItemForSync`
 * already canonicalizes `resolve_key` through the same `new URL()`-based `canonicalizeUrl` at the
 * write chokepoint, but a context-path mismatch is a genuine path difference `canonicalizeUrl`
 * cannot and does not paper over.
 */
export function jiraUrlMatchesConfiguredBase(url: string, configuredBaseUrl: string): boolean {
  let base: URL;
  let requested: URL;
  try {
    base = new URL(configuredBaseUrl);
    requested = new URL(url);
  } catch {
    return false;
  }
  if (base.protocol !== requested.protocol || base.host !== requested.host) {
    return false;
  }
  return pathIsUnderBase(base.pathname, requested.pathname);
}

/** `historyFloorMs` (epoch ms) as a JQL-comparable `yyyy/MM/dd HH:mm` literal. */
function jqlFloorFromMs(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${String(y)}/${mo}/${da} ${h}:${mi}`;
}

/**
 * Honors `SyncContext.historyFloorMs` (opt-in, see `sync/types.ts`) on a COLD
 * START only — an existing cursor is always more recent.
 */
function jiraJqlFromCursor(
  prev: JiraSyncCursorV1 | null,
  initialSyncDepthDays: number,
  historyFloorMs: number | undefined,
): string {
  const hasFloor = prev?.floorJql !== null && prev?.floorJql !== undefined && prev.floorJql !== "";
  let jqlBase: string;
  if (hasFloor) {
    jqlBase = `updated > "${prev.floorJql}"`;
  } else if (historyFloorMs !== undefined && Number.isFinite(historyFloorMs)) {
    jqlBase = `updated >= "${jqlFloorFromMs(historyFloorMs)}"`;
  } else {
    jqlBase = `updated >= -${String(initialSyncDepthDays)}d`;
  }
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
    fields: [
      "summary",
      "description",
      "updated",
      "issuetype",
      "status",
      "creator",
      "created",
      "resolutiondate",
      "parent",
      "duedate",
    ],
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

/**
 * The shared ticket-depth metadata contract (see
 * `git show e4828bcd:docs/superpowers/specs/2026-08-07-ticket-depth-jira-linear-design.md`).
 * Linear's mapper writes the SAME key names, so no consumer branches on
 * service. A field the API did not supply omits its key entirely.
 */
/**
 * `stringField` on a NESTED record (`fields.issuetype.name`), or `undefined`
 * when either level is missing.
 */
function nestedStringField(
  fields: Record<string, unknown>,
  outerKey: string,
  innerKey: string,
): string | undefined {
  const outer = asRecord(fields[outerKey]);
  return outer === undefined ? undefined : stringField(outer, innerKey);
}

/**
 * Assign only when there is something to say.
 *
 * These two exist because `jiraDepthMetadata` repeated the same
 * `if (v !== undefined && v !== "")` guard eight times, which is what pushed it
 * past the cognitive-complexity threshold (Sonar S3776, scored 17). The
 * distinction between them is real and not cosmetic: an empty STRING is Jira
 * saying "this field exists and is blank", which carries no information and
 * must not be indexed as though it did — whereas a numeric 0 from `msFromIso`
 * is a genuine epoch timestamp and must be kept.
 */
function putIfNonEmpty(meta: Record<string, unknown>, key: string, v: string | undefined): void {
  if (v !== undefined && v !== "") {
    meta[key] = v;
  }
}

function putIfDefined(meta: Record<string, unknown>, key: string, v: number | undefined): void {
  if (v !== undefined) {
    meta[key] = v;
  }
}

function jiraDepthMetadata(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  const meta: Record<string, unknown> = { meta_v: TICKET_META_VERSION };
  if (fields === undefined) {
    meta["status_category"] = normalizeJiraStatusCategory(undefined);
    return meta;
  }

  putIfNonEmpty(meta, "issue_type", nestedStringField(fields, "issuetype", "name"));
  putIfNonEmpty(meta, "status", nestedStringField(fields, "status", "name"));

  const status = asRecord(fields["status"]);
  const category = status === undefined ? undefined : asRecord(status["statusCategory"]);
  const rawKey = category === undefined ? undefined : stringField(category, "key");
  putIfNonEmpty(meta, "status_category_raw", rawKey);
  // Unconditional, unlike every other field here: a normalized category is
  // always derivable (`unknown` when the raw key is absent or unrecognised),
  // and a consumer branching on it must never have to handle it being missing.
  meta["status_category"] = normalizeJiraStatusCategory(rawKey);

  putIfDefined(meta, "created_at_ms", msFromIso(stringField(fields, "created")));
  putIfDefined(meta, "resolved_at_ms", msFromIso(stringField(fields, "resolutiondate")));
  putIfDefined(meta, "due_at_ms", msFromIso(stringField(fields, "duedate")));

  // Populated on team-managed projects only. Classic company-managed projects
  // express epic membership through a per-instance `customfield_100xx`, which
  // this connector deliberately does not chase — `parent_key` is simply absent
  // there, and epics stay identifiable via `issue_type`.
  putIfNonEmpty(meta, "parent_key", nestedStringField(fields, "parent", "key"));

  return meta;
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
    metadata: { jiraId: id ?? key, key, ...jiraDepthMetadata(fields) },
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
 *
 * KNOWN BOUND: a Jira Server/Data Center instance mounted under a context path (a common
 * self-hosted deployment shape, e.g. `https://jira.acme.com/jira/browse/ABC-1`) can never match
 * this regex — `[^/]+` stops at the first `/` after the host, so the path must start with
 * `/browse/` directly. Such a URL is `unsupported_url` here, same as the board-deep-link bound
 * documented on `jiraKeyFromUrl` below: declining is free (zero network calls), so this is a
 * capability gap, not a correctness bug, but a context-pathed Jira Server cannot be
 * targeted-fetched by ANY URL shape today.
 */
export const JIRA_BROWSE_URL_RE = /^https?:\/\/[^/]+\/browse\/([A-Z][A-Z0-9_]{0,50}-\d{1,10})$/;

/**
 * A board/backlog deep link carrying `selectedIssue=<KEY>-<N>` in the query string. Deliberately
 * bounded on purpose: Jira's other shapes (agile boards, `/projects/X/issues/...`) vary too much
 * across Cloud and Server to support blind, and `unsupported_url` is what declining them is for —
 * this function does not guess a key from an arbitrary path.
 */
const JIRA_SELECTED_ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{0,50}-\d{1,10}$/;

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
    // KNOWN BOUND: `jiraIndexOneIssue` always writes `resolve_key` as the issue's canonical
    // `<base>/browse/<KEY>` URL (see its `browseUrl` construction), never this board/backlog deep
    // link — that's intentional, since the `/browse/` URL is the durable, shareable identity for
    // the issue and this board URL is one of arbitrarily many deep links that can point at it. It
    // does mean a fetch initiated from THIS board URL indexes the issue under a DIFFERENT key, so
    // re-opening a resolve-by-URL panel on the same board URL will miss again and re-fetch rather
    // than resolve on the first try — bounded by the connector's rate limiter, but not the
    // one-shot fix a `/browse/` link gets. Do not "fix" this by writing the board URL as the
    // resolve key instead: that would make the row unresolvable from its own canonical link.
    return selected;
  }
  return null;
}

/**
 * Whether `jiraKeyFromUrl` accepts `url` — i.e. whether `fetchOne` would make an outbound request
 * for it. `sync/targeted-fetch.ts` calls this BEFORE appending an egress row, so a URL shape
 * `fetchOne` would decline (e.g. a board deep link with no `selectedIssue`, or a context-pathed
 * Jira Server URL) never ledgers an `authorized` row for a call that provably never left the
 * machine (I29 Critical 2).
 *
 * `configuredBaseUrl` — when the caller has one to give (assemble.ts's dispatcher fetches it
 * fresh, same as the host map, never cached) — additionally runs `jiraUrlMatchesConfiguredBase`,
 * so this predicate stays in lockstep with `fetchOneIssue`'s own base-URL check below: a URL
 * `fetchOneIssue` will reject for a base mismatch must ALSO be declined here, or the egress
 * append above would over-claim for a call that never reaches the network. Omitting it (the
 * argument is optional) falls back to the shape-only check — never a mismatch beyond what
 * `jiraKeyFromUrl` already catches.
 */
export function jiraFetchOneUrlIsSupported(
  url: string,
  configuredBaseUrl?: string | null,
): boolean {
  if (jiraKeyFromUrl(url) === null) {
    return false;
  }
  if (configuredBaseUrl === undefined || configuredBaseUrl === null) {
    return true;
  }
  return jiraUrlMatchesConfiguredBase(url, configuredBaseUrl);
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
    return { status: "not_found", reason: "no_credential" };
  }
  // The host boundary (`sync/fetch-host-boundary.ts`) proves only that `url`'s HOST is claimed by
  // Jira — it does not check scheme, port, or a context path. A caller URL whose spelling
  // diverges from the CONFIGURED base (chiefly: the base has a context path the caller's URL
  // omits) must be rejected here, before any outbound request — dispatching anyway would write
  // `resolve_key` under the configured base, a key the caller's own URL could never resolve
  // again.
  if (!jiraUrlMatchesConfiguredBase(url, creds.baseUrl)) {
    return { status: "unsupported_url" };
  }
  const detailUrl = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(requestedKey)}`;
  let res: Response;
  try {
    res = await fetch(detailUrl, {
      headers: {
        Accept: "application/json",
        Authorization: basicAuthHeader(creds.email, creds.token),
      },
      // Bounds this single-item fetch so `POST /v1/items/fetch` can never hang on a stalled
      // upstream response (see `FETCH_ONE_TIMEOUT_MS`'s doc comment in `sync/types.ts`). Covers
      // the body read below too — an abort mid-stream rejects `res.text()`, caught by the same
      // handler.
      signal: AbortSignal.timeout(FETCH_ONE_TIMEOUT_MS),
    });
  } catch {
    // A DNS/TLS/connect failure can carry the request URL — which embeds the Vault-stored
    // `base_url` — in its message. Swallow it entirely rather than let it propagate.
    return { status: "not_found", reason: "unreachable" };
  }
  if (!res.ok) {
    return fetchOneMissForResponse(res.status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.text()) as unknown;
  } catch {
    return { status: "not_found", reason: "upstream_error" };
  }
  const issue = asRecord(parsed);
  if (issue === undefined) {
    return { status: "not_found", reason: "upstream_error" };
  }
  // The returned itemId MUST reflect the row `jiraIndexOneIssue` actually wrote, which keys off
  // the API response's own `key` field — never the raw regex capture from the caller's URL. A
  // Jira issue can be MOVED between projects, which changes its key; an old `/browse/` link then
  // 200s with the issue's CURRENT key, which can differ from the one in the URL.
  //
  // KNOWN BOUND, same shape as the board-deep-link and context-path bounds documented above: a
  // `/browse/` link to an issue that has since MOVED indexes the issue under its CURRENT key, with
  // `resolve_key` set to the issue's CURRENT canonical URL — never the caller's original (now
  // stale) `/browse/<old-key>` link. This is intentional, not a bug to fix: the row id is derived
  // from the API response's key, so the periodic sync owns this row and would overwrite any
  // caller-URL key with the canonical one on its next pass regardless — storing the old URL would
  // be transient and inconsistent, and the issue's canonical URL has genuinely changed. The
  // consequence is that a resolve-by-URL panel opened on the OLD link keeps missing and
  // re-fetching rather than resolving on the first try — bounded by the connector's rate limiter,
  // but not the one-shot fix an unmoved issue's `/browse/` link gets.
  const returnedKey = stringField(issue, "key");
  if (returnedKey === undefined || returnedKey === "") {
    return { status: "not_found", reason: "upstream_error" };
  }
  // `jiraIndexOneIssue` returns `false` only when the issue object it's handed has no usable
  // `key` — but that's the SAME `issue` object, and the same field, already checked above as
  // `returnedKey`. There is no code path here where it returns `false`.
  jiraIndexOneIssue({
    ctx,
    issue,
    syncTime: Date.now(),
    baseUrl: creds.baseUrl,
    maxUpdatedIso: { value: "" },
  });
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
      const jql = jiraJqlFromCursor(prev, initialSyncDepthDays, ctx.historyFloorMs);

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
