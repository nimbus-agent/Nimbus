import { itemPrimaryKey, upsertIndexedItemForSync } from "../index/item-store.ts";
import { stripTrailingSlashes } from "../string/strip-trailing-slashes.ts";
import { clampSyncTitle } from "../sync/pass-cursor-sync-result.ts";
import {
  type FetchOneResult,
  type Syncable,
  type SyncContext,
  type SyncResult,
  syncNoopResult,
} from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import {
  flattenJenkinsApiJobs,
  JENKINS_JOBS_API_TREE,
  type JenkinsApiJobNode,
} from "./jenkins-api-jobs.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "jenkins";
const CURSOR_PREFIX = "nimbus-jnk1:";

type JenkinsSyncCursorV1 = { jobs: Record<string, number> };

function encodeCursor(c: JenkinsSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): JenkinsSyncCursorV1 | null {
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
  const jobsRaw = rec["jobs"];
  if (jobsRaw === null || typeof jobsRaw !== "object" || Array.isArray(jobsRaw)) {
    return { jobs: {} };
  }
  const jobs: Record<string, number> = {};
  for (const [k, v] of Object.entries(jobsRaw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      jobs[k] = Math.floor(v);
    }
  }
  return { jobs };
}

function jobPathFromFullName(fullName: string): string {
  const segs = fullName
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segs.length === 0) {
    return "";
  }
  return segs.map((s) => encodeURIComponent(s)).join("/job/");
}

function jenkinsJobRoot(base: string, fullName: string): string {
  const path = jobPathFromFullName(fullName);
  return `${base}/job/${path}`;
}

function basicAuthHeader(user: string, token: string): string {
  const b64 = Buffer.from(`${user}:${token}`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

async function jenkinsGetJson(
  url: string,
  auth: string,
): Promise<{ ok: boolean; status: number; text: string; json: unknown }> {
  const res = await fetch(url, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  const text = await res.text();
  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(text) as unknown;
  } catch {
    parsedBody = null;
  }
  return { ok: res.ok, status: res.status, text, json: parsedBody };
}

function buildTitle(
  jobFullName: string,
  num: number,
  result: string | undefined,
  building: boolean,
): string {
  let suffix = "";
  if (result !== undefined && result !== "") {
    suffix = ` — ${result}`;
  } else if (building) {
    suffix = " (running)";
  }
  return `${jobFullName} #${String(num)}${suffix}`;
}

/**
 * The `<jobFullName>#<num>` external-id shape shared by `upsertJenkinsBuildRowIfNew` and
 * `fetchOne`. Both MUST derive this from the same source so the id `fetchOne` returns can never
 * diverge from the id the row was actually written under.
 */
function jenkinsBuildExternalId(jobFullName: string, num: number): string {
  return `${jobFullName}#${String(num)}`;
}

function upsertJenkinsBuildRowIfNew(
  ctx: SyncContext,
  job: { fullName: string; url?: string },
  br: unknown,
  lastSeen: number,
  floorMs: number,
  now: number,
  /**
   * The exact, unencoded browser URL a caller is fetching-one-by, when there is one. Used
   * VERBATIM for both `url` and `canonicalUrl`, ahead of BOTH the build response's own `url`
   * field AND `job.url` — mirrors `_lib/gitlab/events.ts`'s `GitlabEventUpsertFields.webUrl`
   * exactly.
   *
   * MUST be sourced from the CALLER's own URL, never from anything remote-supplied: the build
   * response's `url` and `job.url` (built from the Vault-stored `jenkins.base_url`) can both
   * diverge from the URL the caller actually used — a misconfigured `base_url`
   * (`http://localhost:8080/` while the instance is really reached at `https://ci.example.com`)
   * would otherwise write a cleartext-localhost `resolve_key` the caller's real URL can never
   * match. The periodic sync has no caller URL, so `webUrl` stays undefined there and its rows
   * are byte-identical to before this fix.
   */
  webUrl?: string,
): { upserted: boolean; num: number } | null {
  const b = asRecord(br);
  if (b === undefined) {
    return null;
  }
  const num = numberField(b, "number");
  if (num === undefined || num <= lastSeen) {
    return null;
  }
  const ts = numberField(b, "timestamp");
  const modifiedAt = ts !== undefined && Number.isFinite(ts) ? Math.floor(ts) : now;
  if (modifiedAt < floorMs) {
    return null;
  }
  const result = stringField(b, "result");
  const building = b["building"] === true;
  const url = webUrl ?? stringField(b, "url") ?? job.url ?? null;
  const duration = numberField(b, "duration");
  const titleRaw = buildTitle(job.fullName, num, result, building);
  const externalId = jenkinsBuildExternalId(job.fullName, num);
  const meta: Record<string, unknown> = {
    jobName: job.fullName,
    buildNumber: num,
    result: result ?? null,
    building,
    duration_ms: duration ?? null,
  };
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "ci_run",
    externalId,
    title: clampSyncTitle(titleRaw),
    bodyPreview: "",
    url,
    canonicalUrl: url,
    modifiedAt,
    authorId: null,
    metadata: meta,
    pinned: false,
    syncedAt: now,
  });
  return { upserted: true, num };
}

async function syncJenkinsJobBuilds(
  ctx: SyncContext,
  job: { fullName: string; url?: string },
  base: string,
  auth: string,
  lastSeen: number,
  floorMs: number,
  now: number,
): Promise<{ upserted: number; bytes: number; maxNum: number }> {
  const tree = encodeURIComponent("builds[number,url,result,duration,timestamp,building]{0,25}");
  const bUrl = `${jenkinsJobRoot(base, job.fullName)}/api/json?tree=${tree}`;
  const bRes = await jenkinsGetJson(bUrl, auth);
  const bytes = bRes.text.length;
  if (!bRes.ok || bRes.json === null || typeof bRes.json !== "object") {
    return { upserted: 0, bytes, maxNum: lastSeen };
  }
  const buildsRaw = (bRes.json as Record<string, unknown>)["builds"];
  if (!Array.isArray(buildsRaw)) {
    return { upserted: 0, bytes, maxNum: lastSeen };
  }
  let maxNum = lastSeen;
  let upserted = 0;
  for (const br of buildsRaw) {
    const r = upsertJenkinsBuildRowIfNew(ctx, job, br, lastSeen, floorMs, now);
    if (r === null) {
      continue;
    }
    upserted += 1;
    if (r.num > maxNum) {
      maxNum = r.num;
    }
  }
  return { upserted, bytes, maxNum };
}

async function runJenkinsSyncAfterAuth(
  ctx: SyncContext,
  cursor: string | null,
  base: string,
  auth: string,
  initialSyncDepthDays: number,
  t0: number,
): Promise<SyncResult> {
  const prev = decodeCursor(cursor) ?? { jobs: {} };
  const nextJobs: Record<string, number> = { ...prev.jobs };
  let upserted = 0;
  let bytes = 0;

  await ctx.rateLimiter.acquire("jenkins");

  const jobsUrl = `${base}/api/json?tree=${encodeURIComponent(JENKINS_JOBS_API_TREE)}`;
  const jobsRes = await jenkinsGetJson(jobsUrl, auth);
  bytes += jobsRes.text.length;
  if (!jobsRes.ok || jobsRes.json === null || typeof jobsRes.json !== "object") {
    ctx.logger.warn(
      { serviceId: SERVICE_ID, status: jobsRes.status },
      "jenkins sync: failed to list jobs",
    );
    return {
      cursor: encodeCursor(prev),
      itemsUpserted: 0,
      itemsDeleted: 0,
      hasMore: false,
      durationMs: Math.round(performance.now() - t0),
      bytesTransferred: bytes,
    };
  }

  const jobsRoot = jobsRes.json as Record<string, unknown>;
  const jobsArr = jobsRoot["jobs"];
  const flat: { fullName: string; url?: string }[] = [];
  flattenJenkinsApiJobs(
    Array.isArray(jobsArr) ? (jobsArr as JenkinsApiJobNode[]) : undefined,
    flat,
  );

  const now = Date.now();
  const floorMs = now - initialSyncDepthDays * 86_400_000;

  for (const job of flat) {
    const lastSeen = nextJobs[job.fullName] ?? 0;
    const r = await syncJenkinsJobBuilds(ctx, job, base, auth, lastSeen, floorMs, now);
    bytes += r.bytes;
    upserted += r.upserted;
    nextJobs[job.fullName] = r.maxNum;
  }

  return {
    cursor: encodeCursor({ jobs: nextJobs }),
    itemsUpserted: upserted,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: Math.round(performance.now() - t0),
    bytesTransferred: bytes,
  };
}

/**
 * `https://<host>/job/<name>/.../<n>/` — the only shape targeted fetch supports. Nested Jenkins
 * folders are repeated `/job/` segments, so the path capture allows up to 10 of them.
 *
 * Anchored at both ends and every quantifier bounded: the caller-supplied URL reaches an API
 * path, so a permissive pattern here is a request-forgery surface, not a convenience.
 */
export const JENKINS_BUILD_URL_RE =
  /^https?:\/\/[^/]+((?:\/job\/[\w.%-]{1,100}){1,10})\/(\d{1,10})\/?$/;

/** A capture that is entirely dots (`.`, `..`, `...`) is a path-traversal segment, not a name. */
const ALL_DOTS_RE = /^\.+$/;

const JOB_PATH_PREFIX = "/job/";

/**
 * Decodes a captured `/job/<a>/job/<b>` path into `["a", "b"]`, the exact inverse of
 * `jobPathFromFullName`'s `segs.map((s) => s.trim()).filter(...).map(encodeURIComponent).join("/job/")`.
 * Rejects (returns `null`) on any segment that fails to `decodeURIComponent`, that once decoded
 * is entirely dots, that contains a literal `/` (smuggled via a percent-encoded slash), OR that
 * `.trim()`s to something different from itself.
 *
 * Unlike GitLab's single opaque `/projects/:id` path parameter, each Jenkins job segment is
 * re-`encodeURIComponent`-ed and re-joined with a literal `/job/` separator by
 * `jobPathFromFullName` — so a decoded segment of `".."` reaches the wire as a bare `..` between
 * real `/` characters (dots are unreserved and survive `encodeURIComponent` unescaped), a genuine
 * traversal segment the URL parser would normalize away. Every segment must be checked
 * individually — a single all-dots segment anywhere in a multi-folder path is still dangerous.
 *
 * The `name !== name.trim()` check exists because `jobPathFromFullName` ALSO `.trim()`s each
 * segment before re-encoding it, so a decoded name carrying leading/trailing whitespace
 * (reachable via `%20`, `%09`, `%0a`, `%c2%a0`, ...) is not a fixed point of it: the request this
 * file actually issues goes to the TRIMMED job (a real, different job that may legitimately
 * exist), while a naive write would key the row on the UNTRIMMED name — forking a duplicate
 * external id that shares the real job's `url`/`resolve_key` and makes the real build permanently
 * `ambiguous` on resolve.
 *
 * Deliberately NOT a round-trip through `jobPathFromFullName`'s re-`encodeURIComponent` output:
 * that would also reject perfectly valid, differently-cased or over-encoded percent-encoding
 * (lowercase hex, or `%2E`/`%7E`/`%27`/`%21`/`%2A`/`%28` for characters `encodeURIComponent`
 * itself never escapes) — `decodeURIComponent` already normalizes those to the same string
 * either way, so there is nothing ambiguous about them to reject. The whitespace check targets
 * exactly the one place `jobPathFromFullName` transforms its input beyond a straight decode.
 */
function jenkinsJobNameSegmentsFromCapturedPath(capturedPath: string): string[] | null {
  const withoutLeadingJob = capturedPath.startsWith(JOB_PATH_PREFIX)
    ? capturedPath.slice(JOB_PATH_PREFIX.length)
    : capturedPath;
  const rawSegments = withoutLeadingJob.split(JOB_PATH_PREFIX);
  const decoded: string[] = [];
  for (const seg of rawSegments) {
    let name: string;
    try {
      name = decodeURIComponent(seg);
    } catch {
      return null;
    }
    // A decoded segment containing "/" (from a percent-encoded slash, e.g. "%2F") would smuggle
    // an extra job-path level past the regex's per-segment character class when re-encoded by
    // `jobPathFromFullName` — reject it outright rather than let it re-split unexpectedly.
    if (name === "" || name.includes("/") || name !== name.trim() || ALL_DOTS_RE.test(name)) {
      return null;
    }
    decoded.push(name);
  }
  return decoded;
}

/**
 * Fetch and index ONE Jenkins build by its web URL. See `Syncable.fetchOne` for the contract: no
 * rate-limiter call, no egress append, no host-boundary check — those belong to the orchestrator
 * that calls this. This function's job is parse → call → map → upsert → return.
 *
 * `upsertJenkinsBuildRowIfNew` is a NO-OP — it returns `null` and writes nothing — when the passed
 * `lastSeen`/`floorMs` say the build was already covered by a previous periodic sync tick or
 * predates the connector's initial-sync depth window. A targeted fetch has neither concept — it
 * is not resuming a cursor, and "too old for periodic sync" is exactly the case fetch-on-miss
 * exists for — so this calls it with `lastSeen: 0` and `floorMs: 0`, which disables both skip
 * conditions for the overwhelming majority of real responses. But `num <= lastSeen` (0) still
 * fires for `number: 0`, and `modifiedAt < floorMs` (0) still fires for a negative timestamp — so
 * a `null` return here is not merely hypothetical, and MUST be treated as "nothing was written",
 * never as success: this function checks it and returns `not_found` rather than reporting
 * `indexed` for a row that does not exist.
 */
type ParsedJenkinsBuildUrl = { readonly jobFullName: string; readonly num: number };

/**
 * Pure, synchronous, NETWORK-FREE parse of a Jenkins build URL. Single source of truth for "does
 * this URL match the shape `fetchOne` supports" — reused by `fetchOneBuild` (below) AND by
 * `jenkinsFetchOneUrlIsSupported` (the targeted-fetch orchestrator's pre-check,
 * `sync/targeted-fetch.ts`), so the two can never disagree about which URLs are supported.
 */
function parseJenkinsBuildUrl(url: string): ParsedJenkinsBuildUrl | null {
  const m = JENKINS_BUILD_URL_RE.exec(url);
  if (m === null) {
    return null;
  }
  const capturedJobPath = m[1] as string;
  const segments = jenkinsJobNameSegmentsFromCapturedPath(capturedJobPath);
  if (segments === null) {
    return null;
  }
  return { jobFullName: segments.join("/"), num: Number.parseInt(m[2] as string, 10) };
}

/**
 * Whether `parseJenkinsBuildUrl` accepts `url` — i.e. whether `fetchOne` would make an outbound
 * request for it. `sync/targeted-fetch.ts` calls this BEFORE appending an egress row, so a URL
 * shape `fetchOne` would decline never ledgers an `authorized` row for a call that provably never
 * left the machine (I29 Critical 2).
 */
export function jenkinsFetchOneUrlIsSupported(url: string): boolean {
  return parseJenkinsBuildUrl(url) !== null;
}

async function fetchOneBuild(ctx: SyncContext, url: string): Promise<FetchOneResult> {
  const parsedUrl = parseJenkinsBuildUrl(url);
  if (parsedUrl === null) {
    return { status: "unsupported_url" };
  }
  const { jobFullName, num: requestedNum } = parsedUrl;

  const baseRaw = await readConnectorSecret(ctx.vault, "jenkins", "base_url");
  const user = await readConnectorSecret(ctx.vault, "jenkins", "username");
  const token = await readConnectorSecret(ctx.vault, "jenkins", "api_token");
  if (
    baseRaw === null ||
    baseRaw.trim() === "" ||
    user === null ||
    user.trim() === "" ||
    token === null ||
    token.trim() === ""
  ) {
    return { status: "not_found" };
  }
  const base = stripTrailingSlashes(baseRaw);
  const auth = basicAuthHeader(user.trim(), token.trim());

  const jobRoot = jenkinsJobRoot(base, jobFullName);
  const buildApiUrl = `${jobRoot}/${String(requestedNum)}/api/json`;
  let bRes: Awaited<ReturnType<typeof jenkinsGetJson>>;
  try {
    bRes = await jenkinsGetJson(buildApiUrl, auth);
  } catch {
    // A DNS/TLS/connect failure can carry the request URL — which embeds the Vault-stored
    // `base_url` — in its message. Swallow it entirely rather than let it propagate.
    return { status: "not_found" };
  }
  if (!bRes.ok || bRes.json === null || typeof bRes.json !== "object") {
    return { status: "not_found" };
  }
  const br = bRes.json as Record<string, unknown>;
  // Fallback `url` serves the same PURPOSE `syncJenkinsJobBuilds` uses `job.url` for — if the
  // build response itself omits its `url` field, `upsertJenkinsBuildRowIfNew` falls back to
  // whatever `job.url` was passed instead of leaving `url`/`canonicalUrl` (and therefore
  // `resolve_key`) null, which would be an indexed-but-unresolvable row the fetch-on-miss loop
  // could never converge on. But it is NOT the same VALUE: `syncJenkinsJobBuilds`'s `job.url` is
  // the job's own root URL (`<jobRoot>/`, with no build number — that's all the periodic listing
  // API hands it), whereas this constructs the actual per-build URL (`<jobRoot>/<n>/`), which is
  // more precise and is what a browser resolving this exact build would have.
  const fallbackUrl = `${jobRoot}/${String(requestedNum)}/`;
  const upserted = upsertJenkinsBuildRowIfNew(
    ctx,
    { fullName: jobFullName, url: fallbackUrl },
    br,
    0,
    0,
    Date.now(),
    url,
  );
  // A `null` return means NOTHING was written (see the docstring above) — the row does not exist,
  // so this must report `not_found`, not `indexed`. The returned itemId is built from `num` on
  // the successful result, which is the API response's own `number` field, never the raw regex
  // capture from the caller's URL (which can differ from it — leading zeros, etc.).
  if (upserted === null) {
    return { status: "not_found" };
  }
  return {
    status: "indexed",
    itemId: itemPrimaryKey(SERVICE_ID, jenkinsBuildExternalId(jobFullName, upserted.num)),
  };
}

export type JenkinsSyncableOptions = {
  ensureJenkinsMcpRunning: () => Promise<void>;
};

export function createJenkinsSyncable(options: JenkinsSyncableOptions): Syncable {
  const initialSyncDepthDays = 14;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 120 * 1000,
    initialSyncDepthDays,
    fetchOne: fetchOneBuild,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureJenkinsMcpRunning();

      const baseRaw = await readConnectorSecret(ctx.vault, "jenkins", "base_url");
      const user = await readConnectorSecret(ctx.vault, "jenkins", "username");
      const token = await readConnectorSecret(ctx.vault, "jenkins", "api_token");
      if (
        baseRaw === null ||
        baseRaw.trim() === "" ||
        user === null ||
        user.trim() === "" ||
        token === null ||
        token.trim() === ""
      ) {
        return syncNoopResult(cursor, t0);
      }
      const base = stripTrailingSlashes(baseRaw);
      const auth = basicAuthHeader(user.trim(), token.trim());

      return runJenkinsSyncAfterAuth(ctx, cursor, base, auth, initialSyncDepthDays, t0);
    },
  };
}
