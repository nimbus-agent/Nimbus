// Phase 7 (the Cost Pack, slice 8): the GitLab requests behind the compute-minute cost sync
// (`gitlab-cost-sync.ts`). Documentation-verified only (2026-11-28); no live response was seen when this was
// written.
//
// GitLab.com: GraphQL `group(fullPath:) { id }`, then `ciMinutesProjectMonthlyUsage(namespaceId:, date:)` (Relay
// pages of `nodes { minutes project { fullPath } }`; `minutes` already includes the runner cost factor). The
// reference states no permission or token scope for the usage query, so a refusal is a stated gap, never a retry.
// Self-managed: `GET /groups/:id/projects?include_subgroups=true`, then `GET /projects/:id/jobs`, newest first,
// until the jobs are older than the month being read.
//
// Every request goes through `fetchSameOriginOnly` to the configured GitLab base, and the PAT is sent only there
// (as `Authorization: Bearer` to GraphQL and `PRIVATE-TOKEN` to REST). Status rules: 401/403/404 are a gap for the
// group; 429 penalises the shared `gitlab` limiter and retries; a 5xx or a body that is not the documented shape
// retries (a body that is not a report must never clear a stored month).
import type { SyncContext } from "../sync/types.ts";
import type { CostMonthOutcome } from "./cost-month-sync.ts";
import { type fetchSameOriginOnly, RedirectRefusedError } from "./same-origin-fetch.ts";

export type GitlabFetch = typeof fetchSameOriginOnly;

/** At most this many GraphQL pages of project usage per group and month (100 projects a page). */
export const GITLAB_MAX_USAGE_PAGES = 20;
/** At most this many REST pages of projects per group (100 a page). */
export const GITLAB_MAX_PROJECT_PAGES = 20;
/** At most this many REST pages of jobs per project and run (100 a page). */
export const GITLAB_MAX_JOB_PAGES = 50;

export const GITLAB_COST_GAPS = {
  access: (group: string): string =>
    `GitLab refused the compute-minute usage for ${group} (GitLab names no required role for this query; a group owner's token is the likely need)`,
  notFound: (group: string): string =>
    `GitLab group ${group} was not found, or this token cannot see it`,
  graphql: (group: string, message: string): string =>
    `GitLab refused the usage query for ${group}: ${message.slice(0, 200)}`,
  redirect: (group: string): string =>
    `GitLab redirected the request for ${group} to another host; the token is never sent there`,
  runnerRatesOnDotCom:
    "[cost.gitlab] runner_rates applies to self-managed GitLab only: GitLab.com minutes already include the runner cost factor; remove it",
  projectCap: (group: string): string =>
    `${group} has more than ${String(GITLAB_MAX_PROJECT_PAGES * 100)} projects; its minutes were not updated`,
  jobCap: (project: string, month: string): string =>
    `more than ${String(GITLAB_MAX_JOB_PAGES * 100)} jobs in ${month} for ${project}: that month is kept as stored`,
} as const;

/** A request's outcome: a parsed body, or what the month loop does about it. */
export type GitlabReply =
  | { kind: "body"; body: unknown }
  | Exclude<CostMonthOutcome, { kind: "ok" }>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function request(
  ctx: SyncContext,
  fetchFn: GitlabFetch,
  url: string,
  init: RequestInit,
  group: string,
): Promise<GitlabReply> {
  await ctx.rateLimiter.acquire("gitlab");
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    // A redirect off the configured host is refused before the token is sent there: a stated gap, not a loop.
    if (e instanceof RedirectRefusedError)
      return { kind: "gap", reason: GITLAB_COST_GAPS.redirect(group) };
    throw e;
  }
  const text = await res.text();
  if (res.status === 429) {
    const sec = Number.parseInt(res.headers.get("retry-after") ?? "60", 10);
    ctx.rateLimiter.penalise("gitlab", Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000);
    return { kind: "retry" };
  }
  if (res.status === 401 || res.status === 403)
    return { kind: "gap", reason: GITLAB_COST_GAPS.access(group) };
  if (res.status === 404) return { kind: "gap", reason: GITLAB_COST_GAPS.notFound(group) };
  if (!res.ok) return { kind: "retry" };
  try {
    return { kind: "body", body: JSON.parse(text) as unknown };
  } catch {
    return { kind: "retry" };
  }
}

export interface GitlabConn {
  readonly ctx: SyncContext;
  readonly fetchFn: GitlabFetch;
  /** `https://<host>/api/v4` */
  readonly apiBase: string;
  readonly pat: string;
  /** Test seam: the job page cap (default {@link GITLAB_MAX_JOB_PAGES}). */
  readonly maxJobPages?: number;
}

/** The GraphQL endpoint of an API base (`…/api/v4` → `…/api/graphql`). */
export function graphqlUrl(apiBase: string): string {
  return apiBase.endsWith("/api/v4")
    ? `${apiBase.slice(0, -"/api/v4".length)}/api/graphql`
    : `${apiBase}/graphql`;
}

async function graphql(
  c: GitlabConn,
  group: string,
  query: string,
  variables: Record<string, unknown>,
) {
  const reply = await request(
    c.ctx,
    c.fetchFn,
    graphqlUrl(c.apiBase),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.pat}` },
      body: JSON.stringify({ query, variables }),
    },
    group,
  );
  if (reply.kind !== "body") return reply;
  const body = reply.body;
  if (!isRecord(body)) return { kind: "retry" } as const;
  const errors = body["errors"];
  if (!isRecord(body["data"]) && Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    const message =
      isRecord(first) && typeof first["message"] === "string" ? first["message"] : "an error";
    return { kind: "gap", reason: GITLAB_COST_GAPS.graphql(group, message) } as const;
  }
  return isRecord(body["data"])
    ? ({ kind: "body", body: body["data"] } as const)
    : ({ kind: "retry" } as const);
}

const GROUP_QUERY = "query($p: ID!) { group(fullPath: $p) { id } }";
const USAGE_QUERY =
  "query($ns: NamespaceID!, $d: Date!, $after: String) { ciMinutesProjectMonthlyUsage(namespaceId: $ns, date: $d, first: 100, after: $after) { nodes { minutes project { fullPath } } pageInfo { hasNextPage endCursor } } }";

/** A group's GraphQL global id, or what to do instead. */
export async function gitlabGroupId(
  c: GitlabConn,
  group: string,
): Promise<{ kind: "id"; id: string } | Exclude<CostMonthOutcome, { kind: "ok" }>> {
  const r = await graphql(c, group, GROUP_QUERY, { p: group });
  if (r.kind !== "body") return r;
  const g = (r.body as Record<string, unknown>)["group"];
  if (g === null) return { kind: "gap", reason: GITLAB_COST_GAPS.notFound(group) };
  const id = isRecord(g) ? g["id"] : null;
  return typeof id === "string" && id.length > 0 ? { kind: "id", id } : { kind: "retry" };
}

/** Every usage node of one group and month (raw, for the syncable to read), or what to do instead. */
export async function gitlabMonthUsage(
  c: GitlabConn,
  group: string,
  namespaceId: string,
  month: string,
): Promise<{ kind: "nodes"; nodes: unknown[] } | Exclude<CostMonthOutcome, { kind: "ok" }>> {
  const nodes: unknown[] = [];
  let after: string | null = null;
  for (let page = 0; page < GITLAB_MAX_USAGE_PAGES; page++) {
    const r = await graphql(c, group, USAGE_QUERY, { ns: namespaceId, d: `${month}-01`, after });
    if (r.kind !== "body") return r;
    const conn = (r.body as Record<string, unknown>)["ciMinutesProjectMonthlyUsage"];
    if (conn === null) return { kind: "gap", reason: GITLAB_COST_GAPS.access(group) };
    if (!isRecord(conn) || !Array.isArray(conn["nodes"]) || !isRecord(conn["pageInfo"]))
      return { kind: "retry" };
    nodes.push(...(conn["nodes"] as unknown[]));
    const info = conn["pageInfo"];
    const next = info["endCursor"];
    if (info["hasNextPage"] !== true) return { kind: "nodes", nodes };
    if (typeof next !== "string") return { kind: "retry" };
    after = next;
  }
  c.ctx.logger.warn(
    { group, month, pages: GITLAB_MAX_USAGE_PAGES },
    "gitlab_billing sync: usage page cap reached",
  );
  return { kind: "retry" };
}

async function rest(
  c: GitlabConn,
  group: string,
  path: string,
  params: readonly (readonly [string, string])[],
) {
  const u = new URL(`${c.apiBase}${path}`);
  for (const [k, v] of params) u.searchParams.append(k, v);
  return request(c.ctx, c.fetchFn, u.toString(), { headers: { "PRIVATE-TOKEN": c.pat } }, group);
}

/** A self-managed group's projects (`{ id, fullPath }`), or what to do instead. */
export async function gitlabGroupProjects(
  c: GitlabConn,
  group: string,
): Promise<
  | { kind: "projects"; projects: { id: number; fullPath: string }[] }
  | Exclude<CostMonthOutcome, { kind: "ok" }>
> {
  const projects: { id: number; fullPath: string }[] = [];
  for (let page = 1; page <= GITLAB_MAX_PROJECT_PAGES; page++) {
    const r = await rest(c, group, `/groups/${encodeURIComponent(group)}/projects`, [
      ["include_subgroups", "true"],
      ["simple", "true"],
      ["per_page", "100"],
      ["page", String(page)],
    ]);
    if (r.kind !== "body") return r;
    if (!Array.isArray(r.body)) return { kind: "retry" };
    for (const p of r.body as unknown[]) {
      if (
        !isRecord(p) ||
        typeof p["id"] !== "number" ||
        typeof p["path_with_namespace"] !== "string"
      ) {
        return { kind: "retry" };
      }
      projects.push({ id: p["id"], fullPath: p["path_with_namespace"] });
    }
    if ((r.body as unknown[]).length < 100) return { kind: "projects", projects };
  }
  return { kind: "month_gap", reason: GITLAB_COST_GAPS.projectCap(group) };
}

/** A job's `created_at` day, or null. */
const createdDay = (j: unknown): string | null => {
  const v = isRecord(j) ? j["created_at"] : null;
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

/**
 * A project's finished jobs, newest first, down to those created before `sinceDay` (a day before the month, so a
 * job queued before midnight and finished inside the month is kept), or what to do instead.
 */
export async function gitlabProjectJobs(
  c: GitlabConn,
  group: string,
  project: { id: number; fullPath: string },
  sinceDay: string,
  month: string,
): Promise<{ kind: "jobs"; jobs: unknown[] } | Exclude<CostMonthOutcome, { kind: "ok" }>> {
  const jobs: unknown[] = [];
  const maxPages = c.maxJobPages ?? GITLAB_MAX_JOB_PAGES;
  for (let page = 1; page <= maxPages; page++) {
    const r = await rest(c, group, `/projects/${String(project.id)}/jobs`, [
      ["scope[]", "success"],
      ["scope[]", "failed"],
      ["scope[]", "canceled"],
      ["per_page", "100"],
      ["page", String(page)],
    ]);
    if (r.kind !== "body") return r;
    if (!Array.isArray(r.body)) return { kind: "retry" };
    const batch = r.body as unknown[];
    jobs.push(...batch);
    const oldest = createdDay(batch[batch.length - 1]);
    if (batch.length < 100 || (oldest !== null && oldest < sinceDay)) return { kind: "jobs", jobs };
  }
  return { kind: "month_gap", reason: GITLAB_COST_GAPS.jobCap(project.fullPath, month) };
}
