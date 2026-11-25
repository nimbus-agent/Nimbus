import { asRecord, stringField } from "./unknown-record.ts";

/**
 * The reply parsers of the Jira Service Management Operations on-call step (`jsm-oncall.ts`, Phase 10
 * MB3), split out of it with no behaviour change: pure functions of the reply text, no request, no host.
 * Reply shapes are from the documented API and are NOT verified against a live site.
 */

const SAFE_ACCOUNT_ID = /^[A-Za-z0-9:_.-]{1,128}$/;

export function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** The body at the root or under `data` / `result`, whichever carries `key`. */
export function bodyWith(
  root: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (root === undefined) return undefined;
  for (const candidate of [root, asRecord(root["data"]), asRecord(root["result"])]) {
    if (candidate !== undefined && keys.some((k) => k in candidate)) return candidate;
  }
  return undefined;
}

export type Schedule = { id: string; name: string };

export type SchedulePage = {
  schedules: Schedule[];
  /** Entries that carried no usable id: the page is not a complete list. */
  skipped: number;
  /** The raw `links.next`, or null when there is none. */
  next: string | null;
};

/** A page's `links.next`: the link, null when there is none, or `undefined` when it is malformed. */
function nextLinkOf(holder: Record<string, unknown> | undefined): string | null | undefined {
  const links = holder?.["links"];
  if (links === undefined) return null;
  const linkRec = asRecord(links);
  if (linkRec === undefined) return undefined;
  const raw = linkRec["next"];
  if (typeof raw === "string" && raw !== "") return raw;
  return raw === undefined || raw === null ? null : undefined;
}

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
  const next = nextLinkOf(holder);
  if (next === undefined) return null;
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

export type Participant = { id: string; name: string };

const NESTED_KEYS = ["onCallParticipants", "nextOnCallParticipants"] as const;
const MAX_NESTING = 4;

/** `unreadableUsers` counts entries typed `user` whose id cannot be used: they block a replacement. */
type Walk = { users: Map<string, Participant>; skipped: number; unreadableUsers: number };

/** One participant typed `user`: kept once by id, or counted unreadable when its id cannot be used. */
function addUser(p: Record<string, unknown>, out: Walk): void {
  const id = stringField(p, "id");
  if (id === undefined || !SAFE_ACCOUNT_ID.test(id)) {
    out.skipped += 1;
    out.unreadableUsers += 1;
  } else if (!out.users.has(id)) {
    out.users.set(id, { id, name: stringField(p, "name") ?? id });
  }
}

/** Walks a participant list; false when any list has the wrong type or nests deeper than allowed. */
function walkParticipants(list: unknown, depth: number, out: Walk): boolean {
  if (!Array.isArray(list) || depth > MAX_NESTING) return false;
  for (const raw of list) {
    const p = asRecord(raw);
    if (p === undefined) {
      out.skipped += 1;
      continue;
    }
    if (stringField(p, "type")?.toLowerCase() === "user") {
      addUser(p, out);
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
): { users: Participant[]; skipped: number; unreadableUsers: number } | null {
  const body = bodyWith(parseJson(text), keys);
  if (body === undefined) return null;
  const key = keys.find((k) => k in body);
  if (key === undefined) return null;
  const out: Walk = { users: new Map(), skipped: 0, unreadableUsers: 0 };
  if (!walkParticipants(body[key], 0, out)) return null;
  return {
    users: [...out.users.values()],
    skipped: out.skipped,
    unreadableUsers: out.unreadableUsers,
  };
}
