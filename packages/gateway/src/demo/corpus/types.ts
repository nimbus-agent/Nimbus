/**
 * The synthetic demo corpus (spec § 4.2). Every time is an OFFSET from the seed's `nowMs`
 * (negative = in the past) — never an absolute epoch — so a corpus seeded on any day reads as
 * "today" to agents whose windows are 24h / 48h / 3d / 90d.
 */
export type At = (offsetMs: number) => number;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface DemoPerson {
  readonly key: string;
  readonly email: string; // must end in ".example"
  readonly displayName: string;
  readonly githubLogin: string;
  readonly slackHandle: string;
}

export interface DemoService {
  readonly id: string; // the [metrics.dora.<id>] id and the deployment `nimbus_service_id`
  readonly repo: string; // "acme/<name>" — the github URN is `github:${repo}`
  readonly pagerdutyServiceId: string;
}

export interface DemoItem {
  readonly service: string;
  readonly type: string;
  readonly externalId: string;
  readonly title: string;
  readonly body: string;
  readonly offsetMs: number;
  readonly authorKey?: string;
  readonly url?: string;
  /** Built at seed time so time-valued metadata is offset-derived too. */
  readonly metadata?: (at: At) => Record<string, unknown>;
}

export interface DemoCommit {
  readonly sha: string; // 40 hex
  readonly authorKey: string;
  readonly subject: string;
  readonly offsetMs: number;
}

export interface DemoFile {
  readonly path: string; // POSIX, relative to the workspace root
  readonly lines: readonly string[];
  /** One commit sha per line (same length as `lines`) — the blame. */
  readonly blame: readonly string[];
}

export interface DemoDeployment {
  readonly serviceId: string;
  readonly sha: string;
  readonly offsetMs: number;
  readonly status: "success" | "failure";
  readonly runId: string;
}

export interface DemoCorpus {
  readonly people: readonly DemoPerson[];
  readonly meKey: string;
  readonly services: readonly DemoService[];
  readonly commits: readonly DemoCommit[];
  readonly files: readonly DemoFile[];
  /** Written in this order — issues before PRs (the `resolves` edge), PRs/commits before messages (`mentions`). */
  readonly issues: readonly DemoItem[];
  readonly pullRequests: readonly DemoItem[];
  readonly reviews: readonly DemoItem[];
  readonly ciRuns: readonly DemoItem[];
  readonly deployments: readonly DemoDeployment[];
  readonly incidents: readonly DemoItem[];
  readonly messages: readonly DemoItem[];
  /** PagerDuty freshness: offset of `sync_state.last_sync_at` for connector `pagerduty`. */
  readonly pagerdutyLastSyncOffsetMs: number;
}
