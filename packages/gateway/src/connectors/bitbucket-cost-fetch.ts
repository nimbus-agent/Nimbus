// Phase 7 (the Cost Pack, slice 9): the Bitbucket requests behind the Pipelines-minutes cost sync
// (`bitbucket-cost-sync.ts`). Documentation-verified only (Atlassian's OpenAPI spec, 2026-11-28); no live response
// was seen when this was written.
//
// `GET /2.0/repositories/{workspace}?pagelen=100` lists a workspace's repositories (`values[]` with `uuid` and
// `full_name`, `next` for the following page), then `GET /2.0/repositories/{workspace}/{repo}/pipelines?sort=-created_on`
// lists a repository's pipelines newest first (`uuid`, `created_on`, `completed_on`, `build_seconds_used`). There is
// no workspace-total endpoint.
//
// Every request goes through `fetchSameOriginOnly` to the configured API origin, and the Basic credential is sent
// only there. A `next` link on another origin is refused as a stated gap BEFORE it is requested (a response must
// never choose where the credential goes). Status rules: 401/403/404 are a gap for the workspace; 429 penalises the
// shared `bitbucket` limiter and retries; a 5xx or a body that is not the documented shape retries (a body that is
// not a report must never clear a stored month).
import type { SyncContext } from "../sync/types.ts";
import type { CostMonthOutcome } from "./cost-month-sync.ts";
import { type fetchSameOriginOnly, RedirectRefusedError } from "./same-origin-fetch.ts";

export type BitbucketFetch = typeof fetchSameOriginOnly;

/** At most this many pages of repositories per workspace (100 a page). */
export const BITBUCKET_MAX_REPO_PAGES = 20;
/** At most this many pages of pipelines per repository and run (100 a page). */
export const BITBUCKET_MAX_PIPELINE_PAGES = 50;

export const BITBUCKET_COST_GAPS = {
  access: (workspace: string): string =>
    `Bitbucket refused the workspace ${workspace}: the token cannot read its repositories or pipelines (check the API token's scopes and the workspace slug)`,
  notFound: (workspace: string): string =>
    `Bitbucket workspace ${workspace} was not found, or this token cannot see it`,
  redirect: (workspace: string): string =>
    `Bitbucket pointed the request for ${workspace} at another host; the credential is never sent there`,
  noRepos: (workspace: string): string =>
    `Bitbucket listed no repositories for ${workspace}, though its stored minutes say it had some; the stored month is kept`,
  noPipelines: (workspace: string, month: string): string =>
    `Bitbucket returned no ${month} pipelines for ${workspace}, though its stored minutes say there were some; that month is kept as stored`,
  insecureBase:
    "the Bitbucket API base is not https (http is allowed only for localhost); the credential is never sent over it",
  noCredential:
    "no Bitbucket credential is stored: run `nimbus connector auth bitbucket` with your Atlassian email and an API token",
  repoCap: (workspace: string): string =>
    `${workspace} has more than ${String(BITBUCKET_MAX_REPO_PAGES * 100)} repositories; its minutes were not updated`,
  pipelineCap: (repo: string, since: string): string =>
    `${repo}: more than ${(BITBUCKET_MAX_PIPELINE_PAGES * 100).toLocaleString("en-US")} pipelines since ${since}; its older months are kept as stored`,
  repoDenied: (repo: string): string => `${repo}: no access to its pipelines`,
} as const;

/** A request's outcome: a parsed body, or what the month loop does about it. */
export type BitbucketReply =
  | { kind: "body"; body: unknown }
  | Exclude<CostMonthOutcome, { kind: "ok" }>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface BitbucketConn {
  readonly ctx: SyncContext;
  readonly fetchFn: BitbucketFetch;
  /** `https://api.bitbucket.org/2.0` (a test seam may point it at a loopback fake). */
  readonly apiRoot: string;
  /** The `Authorization` header value (Basic). */
  readonly auth: string;
  /** Test seam: the pipeline page cap (default {@link BITBUCKET_MAX_PIPELINE_PAGES}). */
  readonly maxPipelinePages?: number;
}

/** A 404 body is a miss; the caller says what a miss means (a workspace gap, or an unavailable repository). */
async function request(
  c: BitbucketConn,
  url: string,
  workspace: string,
): Promise<BitbucketReply | { kind: "not_found" } | { kind: "denied" }> {
  await c.ctx.rateLimiter.acquire("bitbucket");
  let res: Response;
  try {
    res = await c.fetchFn(url, { headers: { Authorization: c.auth, Accept: "application/json" } });
  } catch (e) {
    // A redirect off the configured host is refused before the credential is sent there: a stated gap.
    if (e instanceof RedirectRefusedError)
      return { kind: "gap", reason: BITBUCKET_COST_GAPS.redirect(workspace) };
    throw e;
  }
  const text = await res.text();
  if (res.status === 429) {
    const sec = Number.parseInt(res.headers.get("retry-after") ?? "60", 10);
    c.ctx.rateLimiter.penalise("bitbucket", Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000);
    return { kind: "retry" };
  }
  if (res.status === 401 || res.status === 403) return { kind: "denied" };
  if (res.status === 404) return { kind: "not_found" };
  if (!res.ok) return { kind: "retry" };
  try {
    return { kind: "body", body: JSON.parse(text) as unknown };
  } catch {
    return { kind: "retry" };
  }
}

/**
 * The URL of the next page named by a body, or null when there is none; `bad` when the link is not usable: not a
 * string, not on the configured origin, or the page it names was already requested (a link that does not advance
 * would read the same page again and count its rows twice).
 */
function nextLink(
  c: BitbucketConn,
  body: Record<string, unknown>,
  requested: ReadonlySet<string>,
): string | null | "bad" | "foreign" {
  const next = body["next"];
  if (next === undefined || next === null) return null;
  if (typeof next !== "string" || next === "") return "bad";
  let u: URL;
  try {
    u = new URL(next);
  } catch {
    return "bad";
  }
  if (u.origin !== new URL(c.apiRoot).origin) return "foreign";
  return requested.has(u.toString()) ? "bad" : u.toString();
}

/** Follows `next` links from `first`, handing each page's `values` to `take`, up to `maxPages` pages. */
async function pages(
  c: BitbucketConn,
  workspace: string,
  first: string,
  maxPages: number,
  take: (values: unknown[]) => "more" | "stop" | "bad",
): Promise<
  | { kind: "done" }
  | { kind: "capped" }
  | { kind: "not_found" }
  | { kind: "denied" }
  | Exclude<CostMonthOutcome, { kind: "ok" }>
> {
  const requested = new Set<string>();
  let url: string | null = first;
  for (let page = 0; page < maxPages && url !== null; page++) {
    requested.add(new URL(url).toString());
    const r = await request(c, url, workspace);
    if (r.kind === "not_found" || r.kind === "denied") return r;
    if (r.kind !== "body") return r;
    const body = r.body;
    if (!isRecord(body) || !Array.isArray(body["values"])) return { kind: "retry" };
    const verdict = take(body["values"] as unknown[]);
    if (verdict === "bad") return { kind: "retry" };
    if (verdict === "stop") return { kind: "done" };
    const next = nextLink(c, body, requested);
    if (next === "bad") return { kind: "retry" };
    if (next === "foreign") return { kind: "gap", reason: BITBUCKET_COST_GAPS.redirect(workspace) };
    url = next;
  }
  return url === null ? { kind: "done" } : { kind: "capped" };
}

export interface BitbucketRepo {
  readonly uuid: string;
  readonly fullName: string;
}

/** A workspace's repositories (each uuid once), or what to do instead. */
export async function bitbucketWorkspaceRepos(
  c: BitbucketConn,
  workspace: string,
): Promise<{ kind: "repos"; repos: BitbucketRepo[] } | Exclude<CostMonthOutcome, { kind: "ok" }>> {
  const repos: BitbucketRepo[] = [];
  const seen = new Set<string>();
  const first = `${c.apiRoot}/repositories/${encodeURIComponent(workspace)}?pagelen=100`;
  const r = await pages(c, workspace, first, BITBUCKET_MAX_REPO_PAGES, (values) => {
    for (const v of values) {
      if (!isRecord(v) || typeof v["uuid"] !== "string" || typeof v["full_name"] !== "string")
        return "bad";
      // Offset pages can repeat a repository when one is created while paging: each uuid is kept once.
      if (seen.has(v["uuid"])) continue;
      seen.add(v["uuid"]);
      repos.push({ uuid: v["uuid"], fullName: v["full_name"] });
    }
    return "more";
  });
  if (r.kind === "done") return { kind: "repos", repos };
  if (r.kind === "denied") return { kind: "gap", reason: BITBUCKET_COST_GAPS.access(workspace) };
  if (r.kind === "not_found")
    return { kind: "gap", reason: BITBUCKET_COST_GAPS.notFound(workspace) };
  if (r.kind === "capped")
    return { kind: "month_gap", reason: BITBUCKET_COST_GAPS.repoCap(workspace) };
  return r;
}

/** A pipeline's `created_on` day, or null. */
const createdDay = (p: unknown): string | null => {
  const v = isRecord(p) ? p["created_on"] : null;
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

/**
 * A repository's pipelines, newest first, down to those created before `sinceDay` (a few days before the earliest
 * month, so a pipeline started before midnight and finished inside the month is kept), each uuid once; or what to
 * do instead. `unavailable` is a repository whose pipelines Bitbucket reports as not found (Pipelines off, or the
 * repository gone): it adds nothing and its stored lines are kept.
 */
export async function bitbucketRepoPipelines(
  c: BitbucketConn,
  workspace: string,
  repo: BitbucketRepo,
  sinceDay: string,
): Promise<
  | {
      kind: "pipelines";
      pipelines: unknown[];
      /** True when the listing ended on its own or reached `sinceDay`: every month from `sinceDay` on is complete. */
      complete: boolean;
      /** The oldest `created_on` day reached (null: none), which bounds the months an incomplete read covers. */
      oldestDay: string | null;
      /** Why the repository is incomplete (a stated gap), else null. */
      gap: string | null;
    }
  | { kind: "unavailable" }
  | Exclude<CostMonthOutcome, { kind: "ok" }>
> {
  let oldestDay: string | null = null;
  const pipelines: unknown[] = [];
  const seen = new Set<string>();
  const slash = repo.fullName.indexOf("/");
  const slug = slash < 0 ? repo.fullName : repo.fullName.slice(slash + 1);
  const first = `${c.apiRoot}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/pipelines?sort=-created_on&pagelen=100`;
  const r = await pages(
    c,
    workspace,
    first,
    c.maxPipelinePages ?? BITBUCKET_MAX_PIPELINE_PAGES,
    (values) => {
      for (const p of values) {
        const id = isRecord(p) && typeof p["uuid"] === "string" ? p["uuid"] : null;
        if (id !== null) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        pipelines.push(p);
      }
      const oldest = createdDay(values[values.length - 1]);
      if (oldest !== null && (oldestDay === null || oldest < oldestDay)) oldestDay = oldest;
      return values.length === 0 || (oldest !== null && oldest < sinceDay) ? "stop" : "more";
    },
  );
  if (r.kind === "done") {
    return { kind: "pipelines", pipelines, complete: true, oldestDay, gap: null };
  }
  if (r.kind === "not_found") return { kind: "unavailable" };
  // One repository's cap or refusal is that repository's gap: the others are still read and written.
  if (r.kind === "capped") {
    const gap = BITBUCKET_COST_GAPS.pipelineCap(repo.fullName, (oldestDay ?? sinceDay).slice(0, 7));
    return { kind: "pipelines", pipelines, complete: false, oldestDay, gap };
  }
  if (r.kind === "denied") {
    const gap = BITBUCKET_COST_GAPS.repoDenied(repo.fullName);
    return { kind: "pipelines", pipelines: [], complete: false, oldestDay: null, gap };
  }
  return r;
}
