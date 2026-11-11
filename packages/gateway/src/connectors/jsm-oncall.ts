import { ONCALL_SHIFT_ITEM_TYPE } from "../index/oncall-shift-types.ts";
import type { SyncContext } from "../sync/types.ts";
import { usableActorEmail } from "./actor-email.ts";
import { basicAuthHeader } from "./atlassian-api-sync-helpers.ts";
import { isAtlassianCloudId } from "./atlassian-cloud-id.ts";
import { type OncallShiftInput, upsertOncallShift } from "./oncall-shift-items.ts";
import type { OncallOutcome } from "./pagerduty-oncall.ts";
import { asRecord, stringField } from "./unknown-record.ts";

/**
 * The Jira Service Management Operations half of the on-call refresh (Phase 10 MB3), inside the existing
 * `jira` sync run. Host pin (static-pinned by a source test): the Operations API is reached ONLY at the
 * constant below, never at a host taken from the Vault, the cursor or a reply; every request of this step
 * is sent with `redirect: "manual"` and any 3xx is a failure, so the Jira credential cannot be forwarded
 * by a redirect. The cloud id is validated before it enters a path.
 *
 * Reply shapes are from the documented API and are NOT verified against a live site. The reply carries no
 * shift times and (with `flat` off) participants by Atlassian account id, so a JSM row has no start or end
 * and a `shift` of `current` or `next`.
 */
export const JSM_OPS_ROOT = "https://api.atlassian.com/jsm/ops/api";
export const JSM_MAX_SCHEDULES = 50;
export const JSM_MAX_PAGES = 10;
export const JSM_STEP_BUDGET_MS = 60_000;
export const JSM_UNAVAILABLE_BACKOFF_MS = 6 * 3_600_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RATE_LIMIT_PENALTY_MS = 60_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9:_.-]{1,128}$/;

export interface JsmCreds {
  token: string;
  email: string;
  baseUrl: string;
}

/** The on-call fields of the jira sync cursor. */
export interface JsmCursorFields {
  ocAt?: number;
  ocUntil?: number;
  cid?: string;
  cidSite?: string;
}

export interface JsmRun {
  outcome: OncallOutcome | null;
  fields: JsmCursorFields;
}

type Get = { ok: true; text: string } | { ok: false; status: number };

/** Milliseconds left of the step budget; <= 0 means expired. Unbounded before the budget starts. */
type Remaining = () => number;
const UNBOUNDED: Remaining = () => Number.POSITIVE_INFINITY;
const LIMITER_POLL_MS = 200;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for a rate-limit token without ever parking in the limiter's blocking queue (an abandoned
 * `acquire` would keep its mutex hold): a bounded `tryAcquire` poll that gives up when the budget ends.
 */
async function acquireWithin(ctx: SyncContext, remaining: Remaining): Promise<boolean> {
  for (;;) {
    if (remaining() <= 0) return false;
    if (await ctx.rateLimiter.tryAcquire("jira")) return true; // NOSONAR S9382: sequential on purpose
    await pause(Math.min(LIMITER_POLL_MS, Math.max(1, remaining()))); // NOSONAR S9382: bounded poll
  }
}

async function jsmGet(
  ctx: SyncContext,
  creds: JsmCreds,
  url: string,
  remaining: Remaining = UNBOUNDED,
): Promise<Get> {
  if (!(await acquireWithin(ctx, remaining))) return { ok: false, status: 0 };
  const left = remaining();
  if (left <= 0) return { ok: false, status: 0 };
  // One deadline for the request AND its body read; the timer is cleared on every path.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(left, REQUEST_TIMEOUT_MS));
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: basicAuthHeader(creds.email, creds.token),
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (res.status === 429) ctx.rateLimiter.penalise("jira", RATE_LIMIT_PENALTY_MS);
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, text: await res.text() }; // NOSONAR S9382: this request's own body
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** The body at the root or under `data` / `result`, whichever carries `key`. */
function bodyWith(
  root: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (root === undefined) return undefined;
  for (const candidate of [root, asRecord(root["data"]), asRecord(root["result"])]) {
    if (candidate !== undefined && keys.some((k) => k in candidate)) return candidate;
  }
  return undefined;
}

function isAtlassianNetSite(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "https:" && u.hostname.toLowerCase().endsWith(".atlassian.net");
  } catch {
    return false;
  }
}

type CloudId = { cid: string; cidSite: string } | { stop: "unavailable" | "none" };

async function resolveCloudId(
  ctx: SyncContext,
  creds: JsmCreds,
  fields: JsmCursorFields,
): Promise<CloudId> {
  const stored = (await ctx.getSecret("cloud_id"))?.trim() ?? "";
  if (isAtlassianCloudId(stored)) return { cid: stored, cidSite: creds.baseUrl };
  const cached = fields.cid;
  if (cached !== undefined && fields.cidSite === creds.baseUrl && isAtlassianCloudId(cached)) {
    return { cid: cached, cidSite: creds.baseUrl };
  }
  if (!isAtlassianNetSite(creds.baseUrl)) {
    ctx.logger.info(
      { serviceId: "jira" },
      "jsm oncall: no cloud id stored and the site is not an atlassian.net site; skipped",
    );
    return { stop: "none" };
  }
  const res = await jsmGet(ctx, creds, `${creds.baseUrl}/_edge/tenant_info`);
  const body = res.ok ? parseJson(res.text) : undefined;
  const found = body === undefined ? undefined : stringField(body, "cloudId");
  if (found === undefined || !isAtlassianCloudId(found)) {
    ctx.logger.warn(
      { serviceId: "jira" },
      "jsm oncall: the cloud id lookup did not give a valid id",
    );
    return { stop: "none" };
  }
  return { cid: found, cidSite: creds.baseUrl };
}

async function accountIdOf(ctx: SyncContext, creds: JsmCreds): Promise<string | null> {
  const res = await jsmGet(ctx, creds, `${creds.baseUrl}/rest/api/3/myself`);
  const body = res.ok ? parseJson(res.text) : undefined;
  const id = body === undefined ? undefined : stringField(body, "accountId");
  return id === undefined || id === "" ? null : id;
}

type Schedule = { id: string; name: string };

export type SchedulePage = {
  schedules: Schedule[];
  /** Entries that carried no usable id: the page is not a complete list. */
  skipped: number;
  /** The raw `links.next`, or null when there is none. */
  next: string | null;
};

/**
 * One `/schedules` page (`values`, `schedules` or a bare list) with its `links.next`. Null when the reply
 * is not that shape, or `links.next` is present but not a string.
 */
export function parseSchedules(text: string): SchedulePage | null {
  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const rec = asRecord(root);
  const holder = bodyWith(rec, ["values", "schedules"]);
  const list = Array.isArray(root)
    ? (root as unknown[])
    : (holder?.["values"] ?? holder?.["schedules"]);
  if (!Array.isArray(list)) return null;
  let next: string | null = null;
  const links = holder === undefined ? undefined : holder["links"];
  if (links !== undefined) {
    const linkRec = asRecord(links);
    if (linkRec === undefined) return null;
    const raw = linkRec["next"];
    if (typeof raw === "string" && raw !== "") next = raw;
    else if (raw !== undefined && raw !== null) return null;
  }
  const schedules: Schedule[] = [];
  let skipped = 0;
  for (const raw of list) {
    const s = asRecord(raw);
    const id = s === undefined ? undefined : stringField(s, "id");
    if (s === undefined || id === undefined) {
      skipped += 1;
      continue;
    }
    schedules.push({ id, name: stringField(s, "name") ?? id });
  }
  return { schedules, skipped, next };
}

/**
 * A `links.next` is followed only when it is on the one fixed host, over https, with no credentials, no
 * port and no fragment, under this cloud id's `schedules` path. Anything else stops the read (partial).
 */
export function isPinnedNextUrl(next: string, cloudId: string): boolean {
  try {
    const u = new URL(next);
    const rootUrl = new URL(JSM_OPS_ROOT);
    return (
      u.protocol === "https:" &&
      u.hostname === rootUrl.hostname &&
      u.port === "" &&
      u.username === "" &&
      u.password === "" &&
      u.hash === "" &&
      u.pathname === `${rootUrl.pathname}/${cloudId}/v1/schedules`
    );
  } catch {
    return false;
  }
}

type Participant = { id: string; name: string };

const NESTED_KEYS = ["onCallParticipants", "nextOnCallParticipants"] as const;
const MAX_NESTING = 4;

type Walk = { users: Map<string, Participant>; skipped: number };

/** Walks a participant list; false when any list has the wrong type or nests deeper than allowed. */
function walkParticipants(list: unknown, depth: number, out: Walk): boolean {
  if (!Array.isArray(list) || depth > MAX_NESTING) return false;
  for (const raw of list) {
    const p = asRecord(raw);
    if (p === undefined) {
      out.skipped += 1;
      continue;
    }
    const id = stringField(p, "id");
    const type = stringField(p, "type")?.toLowerCase();
    if (type === "user") {
      if (id === undefined || !SAFE_ACCOUNT_ID.test(id)) {
        out.skipped += 1;
      } else if (!out.users.has(id)) {
        out.users.set(id, { id, name: stringField(p, "name") ?? id });
      }
      continue;
    }
    // An escalation (or any non-user) may carry the users it resolves to under a nested list.
    const nested = NESTED_KEYS.filter((k) => k in p);
    if (nested.length === 0) {
      out.skipped += 1;
      continue;
    }
    for (const k of nested) {
      if (!walkParticipants(p[k], depth + 1, out)) return false;
    }
  }
  return true;
}

/**
 * The user participants of an on-calls reply (nested escalation participants included, each user once), and
 * how many participants were skipped. Null when the reply is not the expected shape: no key present, the
 * selected key is not a list, or a nested list is malformed.
 */
export function parseParticipants(
  text: string,
  keys: readonly string[],
): { users: Participant[]; skipped: number } | null {
  const body = bodyWith(parseJson(text), keys);
  if (body === undefined) return null;
  const key = keys.find((k) => k in body);
  if (key === undefined) return null;
  const out: Walk = { users: new Map(), skipped: 0 };
  if (!walkParticipants(body[key], 0, out)) return null;
  return { users: [...out.users.values()], skipped: out.skipped };
}

const CURRENT_KEYS = ["onCallParticipants"] as const;
const NEXT_KEYS = ["nextOnCallParticipants", "onCallParticipants"] as const;

function toShift(
  schedule: Schedule,
  p: Participant,
  shift: "current" | "next",
  accountId: string | null,
): OncallShiftInput {
  return {
    source: "jsm",
    userId: p.id,
    userName: p.name,
    userEmail: usableActorEmail(p.name),
    policyId: null,
    policyName: null,
    level: null,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    startMs: null,
    endMs: null,
    serviceIds: [],
    serviceNames: [],
    serviceMapComplete: false,
    isMe: accountId !== null && p.id === accountId,
    shift,
    url: null,
  };
}

type ReadSchedules = { keep: string[]; complete: boolean; skipped: number };

async function readSchedule(
  ctx: SyncContext,
  creds: JsmCreds,
  root: string,
  schedule: Schedule,
  accountId: string | null,
  nowMs: number,
  acc: ReadSchedules,
  remaining: Remaining,
): Promise<void> {
  const base = `${root}/schedules/${encodeURIComponent(schedule.id)}`;
  for (const [path, keys, shift] of [
    ["on-calls", CURRENT_KEYS, "current"],
    ["next-on-calls", NEXT_KEYS, "next"],
  ] as const) {
    const res = await jsmGet(ctx, creds, `${base}/${path}`, remaining);
    const parsed = res.ok ? parseParticipants(res.text, keys) : null;
    if (parsed === null) {
      acc.complete = false;
      continue;
    }
    acc.skipped += parsed.skipped;
    for (const p of parsed.users) {
      acc.keep.push(upsertOncallShift(ctx, toShift(schedule, p, shift, accountId), nowMs));
    }
  }
}

function logOutcome(ctx: SyncContext, out: OncallOutcome, skipped: number, capped: boolean): void {
  ctx.logger.info(
    {
      serviceId: "jira",
      shifts: out.upserted,
      skipped,
      deleted: out.deleted,
      oncall_partial: !out.complete,
      schedules_capped: capped,
    },
    "jsm oncall refresh",
  );
}

type Collected = { schedules: Schedule[]; complete: boolean; capped: boolean; skipped: number };

/**
 * Follows `links.next` from the first page, bounded by `JSM_MAX_PAGES` and `JSM_MAX_SCHEDULES`, each next
 * URL pinned to the fixed host and this cloud id. A cap, a bad next URL, a failed or unparseable page or an
 * expired budget ends the read as partial; the schedules read so far are still returned.
 */
async function collectSchedules(
  ctx: SyncContext,
  creds: JsmCreds,
  cloudId: string,
  first: SchedulePage,
  remaining: Remaining,
): Promise<Collected> {
  const out: Collected = { schedules: [], complete: true, capped: false, skipped: 0 };
  let page: SchedulePage = first;
  for (let n = 1; ; n += 1) {
    out.skipped += page.skipped;
    if (page.skipped > 0) out.complete = false;
    out.schedules.push(...page.schedules);
    if (out.schedules.length > JSM_MAX_SCHEDULES) {
      out.schedules.length = JSM_MAX_SCHEDULES;
      out.capped = true;
      out.complete = false;
      return out;
    }
    if (page.next === null) return out;
    if (n >= JSM_MAX_PAGES || !isPinnedNextUrl(page.next, cloudId)) {
      out.complete = false;
      return out;
    }
    const res = await jsmGet(ctx, creds, page.next, remaining);
    const parsed = res.ok ? parseSchedules(res.text) : null;
    if (parsed === null) {
      out.complete = false;
      return out;
    }
    page = parsed;
  }
}

/**
 * One refresh. `clock` is injectable so a test can end the 60 s budget. Never throws on a request
 * failure; the caller wraps the rest. `fields.ocAt` is set to `nowMs` (an ATTEMPT, so a failing provider
 * is retried once per interval); a 401, 403 or 404 on the schedule list also sets `ocUntil` six hours out.
 */
export async function runJsmOncall(
  ctx: SyncContext,
  creds: JsmCreds,
  prev: JsmCursorFields,
  nowMs: number,
  clock: () => number = Date.now,
): Promise<JsmRun> {
  const fields: JsmCursorFields = { ocAt: nowMs };
  if (prev.ocUntil !== undefined) fields.ocUntil = prev.ocUntil;
  if (prev.cid !== undefined && prev.cidSite !== undefined) {
    fields.cid = prev.cid;
    fields.cidSite = prev.cidSite;
  }
  const id = await resolveCloudId(ctx, creds, prev);
  if ("stop" in id) return { outcome: null, fields };
  fields.cid = id.cid;
  fields.cidSite = id.cidSite;
  const started = clock();
  const remaining: Remaining = () => JSM_STEP_BUDGET_MS - (clock() - started);
  const root = `${JSM_OPS_ROOT}/${id.cid}/v1`;
  const accountId = await accountIdOf(ctx, creds);
  const listed = await jsmGet(ctx, creds, `${root}/schedules`, remaining);
  if (!listed.ok) {
    if (listed.status === 401 || listed.status === 403 || listed.status === 404) {
      fields.ocUntil = nowMs + JSM_UNAVAILABLE_BACKOFF_MS;
      ctx.logger.info(
        { serviceId: "jira", status: listed.status },
        "jsm oncall: Operations schedules are not available to this account; retry in 6 h",
      );
    }
    return { outcome: { complete: false, upserted: 0, deleted: 0 }, fields };
  }
  delete fields.ocUntil;
  const first = parseSchedules(listed.text);
  if (first === null) return { outcome: { complete: false, upserted: 0, deleted: 0 }, fields };
  const found = await collectSchedules(ctx, creds, id.cid, first, remaining);
  const capped = found.capped;
  const acc: ReadSchedules = { keep: [], complete: found.complete, skipped: found.skipped };
  for (const schedule of found.schedules) {
    if (!SAFE_ID.test(schedule.id)) {
      acc.skipped += 1;
      acc.complete = false;
      continue;
    }
    if (remaining() <= 0) {
      acc.complete = false;
      break;
    }
    await readSchedule(ctx, creds, root, schedule, accountId, nowMs, acc, remaining);
  }
  const deleted = acc.complete ? ctx.replaceItemSet(ONCALL_SHIFT_ITEM_TYPE, acc.keep) : 0;
  const outcome = { complete: acc.complete, upserted: acc.keep.length, deleted };
  logOutcome(ctx, outcome, acc.skipped, capped);
  return { outcome, fields };
}
