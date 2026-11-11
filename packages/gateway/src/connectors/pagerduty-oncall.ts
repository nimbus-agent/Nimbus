import { ONCALL_SHIFT_ITEM_TYPE } from "../index/oncall-shift-types.ts";
import type { SyncContext } from "../sync/types.ts";
import { usableActorEmail } from "./actor-email.ts";
import { type OncallShiftInput, upsertOncallShift } from "./oncall-shift-items.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

/**
 * The PagerDuty half of the on-call refresh (Phase 10 MB3): `/oncalls` for the next 7 days, `/services`
 * (which services each escalation policy covers) and `/users/me` (who "me" is), all on api.pagerduty.com
 * with the sync's own token, inside the existing `pagerduty` sync run (one `sync.run` ledger row, I29).
 * Fail-soft by construction: no request failure throws out of `runPagerdutyOncall`.
 *
 * A COMPLETE fetch (every request ok, no page cap hit) replaces the source's shift set; a partial or
 * capped one upserts what it read and deletes NOTHING, since a capped page set can omit the current shift.
 */
const PD_ROOT = "https://api.pagerduty.com";
const ONCALL_MAX_PAGES = 10;
const SERVICES_MAX_PAGES = 5;
const PAGE_SIZE = 100;
const HORIZON_MS = 7 * 86_400_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 2 * 1024 * 1024;
const RATE_LIMIT_PENALTY_MS = 60_000;

export interface OncallOutcome {
  complete: boolean;
  upserted: number;
  deleted: number;
}

export type PdMe = { id: string | null; email: string | null };
type PdPage = { items: unknown[]; more: boolean };
export type PdServiceMap = {
  ids: Map<string, string[]>;
  names: Map<string, string[]>;
  complete: boolean;
};

/** Parses one `{ <key>: [...], more }` page; null when the body is not that shape. */
export function parsePdPage(text: string, key: string): PdPage | null {
  if (text.length > MAX_BODY_CHARS) return null;
  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const rec = asRecord(root);
  const items = rec?.[key];
  if (rec === undefined || !Array.isArray(items)) return null;
  return { items, more: rec["more"] === true };
}

/** `{ user: { id, email } }` of `/users/me`; null when the body is not that shape. */
export function parseMe(text: string): PdMe | null {
  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const user = asRecord(asRecord(root)?.["user"]);
  if (user === undefined) return null;
  const id = stringField(user, "id");
  return { id: id === undefined || id === "" ? null : id, email: usableActorEmail(user["email"]) };
}

type Get = { ok: true; text: string } | { ok: false; status: number };

async function pdGet(ctx: SyncContext, token: string, pathAndQuery: string): Promise<Get> {
  await ctx.rateLimiter.acquire("pagerduty"); // NOSONAR S9382: sequential on purpose; one request in flight at a time
  try {
    const res = await fetch(`${PD_ROOT}${pathAndQuery}`, {
      headers: {
        Accept: "application/vnd.pagerduty+json;version=2",
        Authorization: `Token token=${token.trim()}`,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 429) ctx.rateLimiter.penalise("pagerduty", RATE_LIMIT_PENALTY_MS);
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, text: await res.text() }; // NOSONAR S9382: this request's own body
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Who "me" is: the user token's `/users/me`, else the `from_email` Vault key; else nobody. */
async function resolveMe(ctx: SyncContext, token: string): Promise<PdMe> {
  const res = await pdGet(ctx, token, "/users/me");
  if (res.ok) {
    const me = parseMe(res.text);
    if (me !== null && (me.id !== null || me.email !== null)) return me;
  }
  const from = await ctx.getSecret("from_email");
  const email = usableActorEmail(from);
  if (email === null) {
    ctx.logger.info(
      { serviceId: "pagerduty" },
      "pagerduty oncall: /users/me unavailable and no from_email; is_me is false for every shift",
    );
  }
  return { id: null, email };
}

function pushTo(m: Map<string, string[]>, key: string, value: string): void {
  const list = m.get(key);
  if (list === undefined) m.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

function addService(map: PdServiceMap, raw: unknown): void {
  const svc = asRecord(raw);
  if (svc === undefined) return;
  const id = stringField(svc, "id");
  const policy = asRecord(svc["escalation_policy"]);
  const policyId = policy === undefined ? undefined : stringField(policy, "id");
  if (id === undefined || id === "" || policyId === undefined || policyId === "") return;
  pushTo(map.ids, policyId, id);
  pushTo(map.names, policyId, stringField(svc, "name") ?? id);
}

async function fetchServiceMap(ctx: SyncContext, token: string): Promise<PdServiceMap> {
  const map: PdServiceMap = { ids: new Map(), names: new Map(), complete: true };
  for (let page = 0; page < SERVICES_MAX_PAGES; page += 1) {
    const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    q.append("include[]", "escalation_policies");
    const res = await pdGet(ctx, token, `/services?${q.toString()}`);
    const parsed = res.ok ? parsePdPage(res.text, "services") : null;
    if (parsed === null) {
      map.complete = false;
      return map;
    }
    for (const raw of parsed.items) addService(map, raw);
    if (!parsed.more) return map;
  }
  map.complete = false;
  return map;
}

type FetchedOncalls = { rows: unknown[]; complete: boolean };

async function fetchOncalls(
  ctx: SyncContext,
  token: string,
  nowMs: number,
): Promise<FetchedOncalls> {
  const rows: unknown[] = [];
  for (let page = 0; page < ONCALL_MAX_PAGES; page += 1) {
    const q = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
      since: new Date(nowMs).toISOString(),
      until: new Date(nowMs + HORIZON_MS).toISOString(),
    });
    for (const inc of ["users", "escalation_policies", "schedules"]) q.append("include[]", inc);
    const res = await pdGet(ctx, token, `/oncalls?${q.toString()}`);
    const parsed = res.ok ? parsePdPage(res.text, "oncalls") : null;
    if (parsed === null) return { rows, complete: false };
    rows.push(...parsed.items);
    if (!parsed.more) return { rows, complete: true };
  }
  return { rows, complete: false };
}

function timeMs(rec: Record<string, unknown>, key: string): number | null {
  const s = stringField(rec, key);
  if (s === undefined) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function isMe(me: PdMe, userId: string, email: string | null): boolean {
  if (me.id !== null) return userId === me.id;
  return me.email !== null && email !== null && me.email.toLowerCase() === email.toLowerCase();
}

function nameOf(rec: Record<string, unknown> | undefined): string | null {
  if (rec === undefined) return null;
  return stringField(rec, "name") ?? stringField(rec, "summary") ?? null;
}

function idOf(rec: Record<string, unknown> | undefined): string | null {
  return rec === undefined ? null : (stringField(rec, "id") ?? null);
}

function urlOf(
  schedule: Record<string, unknown> | undefined,
  policy: Record<string, unknown> | undefined,
): string | null {
  const own = schedule === undefined ? undefined : stringField(schedule, "html_url");
  if (own !== undefined) return own;
  return policy === undefined ? null : (stringField(policy, "html_url") ?? null);
}

/** One `/oncalls` entry as a shift, or null when it names no user. */
export function pdEntryToShift(
  raw: unknown,
  me: PdMe,
  services: PdServiceMap,
): OncallShiftInput | null {
  const entry = asRecord(raw);
  if (entry === undefined) return null;
  const user = asRecord(entry["user"]);
  const userId = idOf(user);
  if (user === undefined || userId === null || userId === "") return null;
  const policy = asRecord(entry["escalation_policy"]);
  const schedule = asRecord(entry["schedule"]);
  const policyId = idOf(policy);
  const email = usableActorEmail(user["email"]);
  return {
    source: "pagerduty",
    userId,
    userName: nameOf(user) ?? userId,
    userEmail: email,
    policyId,
    policyName: nameOf(policy),
    level: numberField(entry, "escalation_level") ?? null,
    scheduleId: idOf(schedule),
    scheduleName: nameOf(schedule),
    startMs: timeMs(entry, "start"),
    endMs: timeMs(entry, "end"),
    serviceIds: policyId === null ? [] : (services.ids.get(policyId) ?? []),
    serviceNames: policyId === null ? [] : (services.names.get(policyId) ?? []),
    serviceMapComplete: services.complete,
    isMe: isMe(me, userId, email),
    url: urlOf(schedule, policy),
  };
}

function writeShifts(
  ctx: SyncContext,
  rows: readonly unknown[],
  me: PdMe,
  services: PdServiceMap,
  nowMs: number,
): { keep: string[]; skipped: number } {
  const keep: string[] = [];
  let skipped = 0;
  ctx.writeBatch(() => {
    for (const raw of rows) {
      const shift = pdEntryToShift(raw, me, services);
      if (shift === null) {
        skipped += 1;
        continue;
      }
      keep.push(upsertOncallShift(ctx, shift, nowMs));
    }
  });
  return { keep, skipped };
}

export async function runPagerdutyOncall(
  ctx: SyncContext,
  token: string,
  nowMs: number,
): Promise<OncallOutcome> {
  const me = await resolveMe(ctx, token);
  const fetched = await fetchOncalls(ctx, token, nowMs);
  const services = await fetchServiceMap(ctx, token);
  const { keep, skipped } = writeShifts(ctx, fetched.rows, me, services, nowMs);
  let deleted = 0;
  if (fetched.complete) deleted = ctx.replaceItemSet(ONCALL_SHIFT_ITEM_TYPE, keep);
  ctx.logger.info(
    {
      serviceId: "pagerduty",
      shifts: keep.length,
      skipped,
      deleted,
      oncall_partial: !fetched.complete,
      service_map_complete: services.complete,
    },
    "pagerduty oncall refresh",
  );
  return { complete: fetched.complete, upserted: keep.length, deleted };
}
