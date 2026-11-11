import {
  ONCALL_SHIFT_ITEM_TYPE,
  ONCALL_SOURCE_SERVICE,
  type OncallShiftMeta,
  type OncallSource,
} from "../index/oncall-shift-types.ts";
import type { SyncContext } from "../sync/types.ts";

export { ONCALL_REFRESH_INTERVAL_MS, ONCALL_STALE_MS } from "../index/oncall-shift-types.ts";

const MAX_NAME_CHARS = 120;

/** One shift as a source describes it; the writer turns it into an `item` row. */
export interface OncallShiftInput {
  source: OncallSource;
  /** The provider's user id (PagerDuty user id, Atlassian account id). Part of the external id only. */
  userId: string;
  userName: string;
  userEmail: string | null;
  policyId: string | null;
  policyName: string | null;
  level: number | null;
  scheduleId: string | null;
  scheduleName: string | null;
  startMs: number | null;
  endMs: number | null;
  serviceIds: readonly string[];
  serviceNames: readonly string[];
  serviceMapComplete: boolean;
  isMe: boolean;
  /** JSM only. */
  shift?: "current" | "next";
  url: string | null;
}

/** Cuts a provider-supplied name to one printable line (it feeds FTS and a terminal). */
export function flattenOncallText(raw: string, max = MAX_NAME_CHARS): string {
  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    const control = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
    out += control ? " " : ch;
  }
  const flat = out
    .split(" ")
    .filter((p) => p !== "")
    .join(" ");
  return flat.length > max ? flat.slice(0, max) : flat;
}

/** `2026-11-12 08:00 UTC`: explicit UTC so every OS gives the same text. */
export function formatOncallUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function oncallShiftExternalId(s: OncallShiftInput): string {
  if (s.source === "jsm") {
    return `oncall:jsm:${s.scheduleId ?? "-"}:${s.shift ?? "current"}:${s.userId}`;
  }
  return (
    `oncall:pd:${s.policyId ?? "-"}:${s.level === null ? "-" : String(s.level)}:` +
    `${s.scheduleId ?? "-"}:${s.userId}:${s.startMs === null ? "-" : String(s.startMs)}`
  );
}

export function oncallShiftTitle(s: OncallShiftInput): string {
  const where = flattenOncallText(s.scheduleName ?? s.policyName ?? "unknown schedule");
  const who = flattenOncallText(s.userName);
  const lead = s.shift === "next" ? "Next on call" : "On call";
  const level = s.level === null ? "" : ` (level ${String(s.level)})`;
  const until = s.endMs === null ? "" : ` until ${formatOncallUtc(s.endMs)}`;
  return `${lead}: ${who} — ${where}${level}${until}`;
}

export function oncallShiftBodyPreview(s: OncallShiftInput): string {
  const policy = flattenOncallText(s.policyName ?? "unknown");
  const covers =
    s.serviceNames.length === 0
      ? "(unknown)"
      : s.serviceNames.map((n) => flattenOncallText(n)).join(", ");
  return `Escalation policy: ${policy}. Covers: ${covers}.`;
}

export function oncallShiftMetadata(s: OncallShiftInput, nowMs: number): OncallShiftMeta {
  const meta: OncallShiftMeta = {
    source: s.source,
    user_name: flattenOncallText(s.userName),
    service_ids: [...s.serviceIds],
    service_names: s.serviceNames.map((n) => flattenOncallText(n)),
    service_map_complete: s.serviceMapComplete,
    is_me: s.isMe,
    fetched_at_ms: nowMs,
  };
  if (s.userEmail !== null) meta.user_email = s.userEmail;
  if (s.policyId !== null) meta.escalation_policy_id = s.policyId;
  if (s.policyName !== null) meta.escalation_policy_name = flattenOncallText(s.policyName);
  if (s.level !== null) meta.escalation_level = s.level;
  if (s.scheduleId !== null) meta.schedule_id = s.scheduleId;
  if (s.scheduleName !== null) meta.schedule_name = flattenOncallText(s.scheduleName);
  if (s.startMs !== null) meta.start_ms = s.startMs;
  if (s.endMs !== null) meta.end_ms = s.endMs;
  if (s.shift !== undefined) meta.shift = s.shift;
  return meta;
}

/** Writes one shift through `ctx.upsertItem`; returns its external id (for the keep set). */
export function upsertOncallShift(ctx: SyncContext, s: OncallShiftInput, nowMs: number): string {
  const externalId = oncallShiftExternalId(s);
  ctx.upsertItem({
    service: ONCALL_SOURCE_SERVICE[s.source],
    type: ONCALL_SHIFT_ITEM_TYPE,
    externalId,
    title: oncallShiftTitle(s),
    bodyPreview: oncallShiftBodyPreview(s),
    url: s.url,
    canonicalUrl: s.url,
    modifiedAt: nowMs,
    authorId: null,
    metadata: { ...oncallShiftMetadata(s, nowMs) },
    pinned: false,
    syncedAt: nowMs,
  });
  return externalId;
}
