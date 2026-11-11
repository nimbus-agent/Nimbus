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

async function jsmGet(ctx: SyncContext, creds: JsmCreds, url: string): Promise<Get> {
  await ctx.rateLimiter.acquire("jira"); // NOSONAR S9382: sequential on purpose; one request in flight at a time
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: basicAuthHeader(creds.email, creds.token),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 429) ctx.rateLimiter.penalise("jira", RATE_LIMIT_PENALTY_MS);
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, text: await res.text() }; // NOSONAR S9382: this request's own body
  } catch {
    return { ok: false, status: 0 };
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

/** The schedules of a `/schedules` reply (`values`, `schedules` or a bare list). */
export function parseSchedules(text: string): Schedule[] | null {
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
  const out: Schedule[] = [];
  for (const raw of list) {
    const s = asRecord(raw);
    const id = s === undefined ? undefined : stringField(s, "id");
    if (s === undefined || id === undefined) continue;
    out.push({ id, name: stringField(s, "name") ?? id });
  }
  return out;
}

type Participant = { id: string; name: string };

/** The user participants of an on-calls reply, and how many non-user participants were skipped. */
export function parseParticipants(
  text: string,
  keys: readonly string[],
): { users: Participant[]; skipped: number } | null {
  const body = bodyWith(parseJson(text), keys);
  if (body === undefined) return null;
  const users: Participant[] = [];
  let skipped = 0;
  for (const key of keys) {
    const list = body[key];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const p = asRecord(raw);
      const id = p === undefined ? undefined : stringField(p, "id");
      const type = p === undefined ? undefined : stringField(p, "type")?.toLowerCase();
      if (p === undefined || id === undefined || type !== "user" || !SAFE_ACCOUNT_ID.test(id)) {
        skipped += 1;
        continue;
      }
      users.push({ id, name: stringField(p, "name") ?? id });
    }
    return { users, skipped };
  }
  return { users, skipped };
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
): Promise<void> {
  const base = `${root}/schedules/${encodeURIComponent(schedule.id)}`;
  for (const [path, keys, shift] of [
    ["on-calls", CURRENT_KEYS, "current"],
    ["next-on-calls", NEXT_KEYS, "next"],
  ] as const) {
    const res = await jsmGet(ctx, creds, `${base}/${path}`);
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
  const root = `${JSM_OPS_ROOT}/${id.cid}/v1`;
  const accountId = await accountIdOf(ctx, creds);
  const listed = await jsmGet(ctx, creds, `${root}/schedules`);
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
  const schedules = parseSchedules(listed.text);
  if (schedules === null) return { outcome: { complete: false, upserted: 0, deleted: 0 }, fields };
  const capped = schedules.length > JSM_MAX_SCHEDULES;
  const acc: ReadSchedules = { keep: [], complete: !capped, skipped: 0 };
  for (const schedule of schedules.slice(0, JSM_MAX_SCHEDULES)) {
    if (!SAFE_ID.test(schedule.id)) {
      acc.skipped += 1;
      acc.complete = false;
      continue;
    }
    if (clock() - started > JSM_STEP_BUDGET_MS) {
      acc.complete = false;
      break;
    }
    await readSchedule(ctx, creds, root, schedule, accountId, nowMs, acc);
  }
  const deleted = acc.complete ? ctx.replaceItemSet(ONCALL_SHIFT_ITEM_TYPE, acc.keep) : 0;
  const outcome = { complete: acc.complete, upserted: acc.keep.length, deleted };
  logOutcome(ctx, outcome, acc.skipped, capped);
  return { outcome, fields };
}
