// Phase 7 (the Cost Pack, slice 10): the Jenkins requests behind the build-minutes cost sync
// (`jenkins-cost-sync.ts`). Documentation-verified only (https://www.jenkins.io/doc/book/using/remote-access-api/ and
// https://javadoc.jenkins.io/hudson/model/AbstractBuild.html); no live response was seen when this was written.
//
// `GET <base>/api/json?tree=<JENKINS_JOBS_API_TREE>` lists the jobs (folders nested four deep, the connector's own
// tree), then per job `GET <base>/job/<a>/job/<b>/api/json?tree=builds[number,timestamp,duration,builtOn,result,
// building]{0,200}` lists its builds newest first, and `{200,400}` and so on up to 1,000 builds per job and run.
//
// Every request goes through `fetchSameOriginOnly` to the configured base's origin, and the Basic credential is
// sent only there. Status rules: 401/403 are a gap (the listing) or a job gap; 404 on a job is "unavailable" (its
// stored lines are kept); 429 penalises the shared `jenkins` limiter and retries; a 5xx or a body that is not the
// documented shape retries (a body that is not a report must never clear a stored month).
import type { SyncContext } from "../sync/types.ts";
import type { CostMonthOutcome } from "./cost-month-sync.ts";
import { JENKINS_JOBS_API_TREE, type JenkinsApiJobNode } from "./jenkins-api-jobs.ts";
import { type fetchSameOriginOnly, RedirectRefusedError } from "./same-origin-fetch.ts";

export type JenkinsFetch = typeof fetchSameOriginOnly;

/** At most this many jobs (folders included) are read per run. */
export const JENKINS_MAX_JOBS = 2000;
export const JENKINS_BUILDS_PAGE = 200;
/** At most this many pages of builds per job and run (1,000 builds). */
export const JENKINS_MAX_BUILD_PAGES = 5;

export const JENKINS_COST_GAPS = {
  access: (host: string): string =>
    `Jenkins at ${host} refused the credential: it cannot read the job list (check jenkins.username and the API token)`,
  notFound: (host: string): string => `Jenkins at ${host} did not answer the job list (not found)`,
  redirect: (host: string): string =>
    `Jenkins at ${host} pointed a request at another origin; the credential is never sent there`,
  noJobs: (host: string): string =>
    `Jenkins at ${host} listed no jobs, though its stored minutes say it had some; the stored month is kept`,
  noBuilds: (host: string, month: string): string =>
    `Jenkins at ${host} returned no ${month} builds, though its stored minutes say there were some; that month is kept as stored`,
  insecureBase:
    "the Jenkins base is not https (http is allowed only for localhost): the token is never sent over plain http; serve Jenkins over https",
  jobCap: (host: string): string =>
    `Jenkins at ${host} has more than ${String(JENKINS_MAX_JOBS)} jobs; its minutes were not updated`,
  buildCap: (job: string, since: string): string =>
    `${job}: more than ${(JENKINS_MAX_BUILD_PAGES * JENKINS_BUILDS_PAGE).toLocaleString("en-US")} builds since ${since}; its older months are kept as stored`,
  jobDenied: (job: string): string => `${job}: no access to its builds`,
} as const;

export interface JenkinsConn {
  readonly ctx: SyncContext;
  readonly fetchFn: JenkinsFetch;
  /** The configured base without a trailing slash. */
  readonly base: string;
  /** The `Authorization` header value (Basic). */
  readonly auth: string;
  /** Test seams. */
  readonly maxJobs?: number;
  readonly maxBuildPages?: number;
}

type Reply =
  | { kind: "body"; body: unknown }
  | { kind: "not_found" }
  | { kind: "denied" }
  | Exclude<CostMonthOutcome, { kind: "ok" }>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function request(c: JenkinsConn, url: string, host: string): Promise<Reply> {
  await c.ctx.rateLimiter.acquire("jenkins");
  let res: Response;
  try {
    res = await c.fetchFn(url, { headers: { Authorization: c.auth, Accept: "application/json" } });
  } catch (e) {
    // A redirect off the configured origin is refused before the credential is sent there: a stated gap.
    if (e instanceof RedirectRefusedError)
      return { kind: "gap", reason: JENKINS_COST_GAPS.redirect(host) };
    throw e;
  }
  const text = await res.text();
  if (res.status === 429) {
    const sec = Number.parseInt(res.headers.get("retry-after") ?? "60", 10);
    c.ctx.rateLimiter.penalise("jenkins", Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000);
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

export interface JenkinsJob {
  /** The job's full name (`folder/job`): its identity here (Jenkins has no stable job id). */
  readonly fullName: string;
}

/**
 * Every node of the listing with its full name built from the NAMES on the path (`folder/job`). The connector's
 * tree asks for `fullname` in lower case, which Jenkins does not export (the property is `fullName`), so a nested
 * job's own name is the only part of the listing that can be relied on: the path is rebuilt from it.
 */
function walkJobs(nodes: readonly JenkinsApiJobNode[], prefix: string, out: string[]): void {
  for (const n of nodes) {
    if (typeof n !== "object" || n === null || typeof n.name !== "string" || n.name === "")
      continue;
    const full = prefix === "" ? n.name : `${prefix}/${n.name}`;
    out.push(full);
    if (Array.isArray(n.jobs)) walkJobs(n.jobs, full, out);
  }
}

/** The base's jobs (each full name once), or what to do instead. */
export async function jenkinsJobList(
  c: JenkinsConn,
  host: string,
): Promise<{ kind: "jobs"; jobs: JenkinsJob[] } | Exclude<CostMonthOutcome, { kind: "ok" }>> {
  const tree = encodeURIComponent(JENKINS_JOBS_API_TREE);
  const r = await request(c, `${c.base}/api/json?tree=${tree}`, host);
  if (r.kind === "denied") return { kind: "gap", reason: JENKINS_COST_GAPS.access(host) };
  if (r.kind === "not_found") return { kind: "gap", reason: JENKINS_COST_GAPS.notFound(host) };
  if (r.kind !== "body") return r;
  if (!isRecord(r.body) || !Array.isArray(r.body["jobs"])) return { kind: "retry" };
  const flat: string[] = [];
  walkJobs(r.body["jobs"] as JenkinsApiJobNode[], "", flat);
  const jobs: JenkinsJob[] = [...new Set(flat)].map((fullName) => ({ fullName }));
  if (jobs.length > (c.maxJobs ?? JENKINS_MAX_JOBS)) {
    return { kind: "month_gap", reason: JENKINS_COST_GAPS.jobCap(host) };
  }
  return { kind: "jobs", jobs };
}

/** `<base>/job/<a>/job/<b>` for the full name `a/b`. */
export function jenkinsJobRootUrl(base: string, fullName: string): string {
  const segs = fullName
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return `${base}/job/${segs.map((s) => encodeURIComponent(s)).join("/job/")}`;
}

const buildsTree = (from: number): string =>
  `builds[number,timestamp,duration,builtOn,result,building]{${String(from)},${String(from + JENKINS_BUILDS_PAGE)}}`;

const dayOf = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString().slice(0, 10);

export type JenkinsJobRead =
  | {
      kind: "builds";
      builds: unknown[];
      /** True when the listing ended on its own or reached `sinceMs`: every month from there on is complete. */
      complete: boolean;
      /** The oldest start day reached (null: none), which bounds the months an incomplete read covers. */
      oldestDay: string | null;
      /** Why the job is incomplete (a stated gap), else null. */
      gap: string | null;
    }
  | { kind: "unavailable" }
  | Exclude<CostMonthOutcome, { kind: "ok" }>;

/**
 * A job's builds, newest first, down to those that started before `sinceMs`, each number once; or what to do
 * instead. `unavailable` is a job Jenkins reports as not found (deleted since the listing): its stored lines are kept.
 */
export async function jenkinsJobBuilds(
  c: JenkinsConn,
  host: string,
  job: JenkinsJob,
  sinceMs: number,
): Promise<JenkinsJobRead> {
  const root = jenkinsJobRootUrl(c.base, job.fullName);
  const builds: unknown[] = [];
  const seen = new Set<string>();
  let oldestMs: number | null = null;
  const pages = c.maxBuildPages ?? JENKINS_MAX_BUILD_PAGES;
  for (let page = 0; page < pages; page++) {
    const tree = encodeURIComponent(buildsTree(page * JENKINS_BUILDS_PAGE));
    const r = await request(c, `${root}/api/json?tree=${tree}`, host); // NOSONAR S9382: one request at a time through the limiter
    if (r.kind === "not_found") return { kind: "unavailable" };
    if (r.kind === "denied") {
      const gap = JENKINS_COST_GAPS.jobDenied(job.fullName);
      return { kind: "builds", builds: [], complete: false, oldestDay: null, gap };
    }
    if (r.kind !== "body") return r;
    if (!isRecord(r.body)) return { kind: "retry" };
    // A folder has no `builds`: it adds nothing. A `builds` that is not a list is not the documented shape.
    const values = r.body["builds"] ?? [];
    if (!Array.isArray(values)) return { kind: "retry" };
    for (const b of values as unknown[]) {
      const n = isRecord(b) && typeof b["number"] === "number" ? String(b["number"]) : null;
      if (n !== null) {
        if (seen.has(n)) continue;
        seen.add(n);
      }
      builds.push(b);
      const ts = isRecord(b) ? b["timestamp"] : null;
      if (typeof ts === "number" && Number.isFinite(ts) && (oldestMs === null || ts < oldestMs)) {
        oldestMs = ts;
      }
    }
    if (values.length < JENKINS_BUILDS_PAGE || (oldestMs !== null && oldestMs < sinceMs)) {
      return { kind: "builds", builds, complete: true, oldestDay: dayOf(oldestMs), gap: null };
    }
  }
  const since = (dayOf(oldestMs) ?? dayOf(sinceMs) ?? "").slice(0, 7);
  const gap = JENKINS_COST_GAPS.buildCap(job.fullName, since);
  return { kind: "builds", builds, complete: false, oldestDay: dayOf(oldestMs), gap };
}
