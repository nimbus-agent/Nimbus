// packages/gateway/src/connectors/connector-writes/scope-gated.ts
// Writes whose connector lists them only when the stored OAuth token holds a scope (Phase 10 SA2,
// spec § 6.5, OR-10-7). A connection made before the scope was requested keeps the scopes it was
// granted (a refresh sends no `scope`), so the connector does not list the tool until the owner
// re-authorises; `connector writes status` and the enable prompt say so instead of showing a write
// that cannot run as offered.

const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
/** The full-mailbox scope, a superset of `gmail.modify`. */
const GMAIL_FULL = "https://mail.google.com/";
/** Either Calendar write scope lists the event writes (connectors 0.20.0 `tool-scope-policy.ts`). */
const CALENDAR_WRITE = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

/** One Google Calendar event write, gated on its own credential's write scope. */
const calendarWrite = (): ScopeGatedWrite => ({
  service: "google_calendar",
  anyOf: CALENDAR_WRITE,
  reason: "re-authorise Google Calendar to grant calendar",
});

export interface ScopeGatedWrite {
  /** The service whose credential's scopes decide (a key of `ModelWritesDeps.grantedScopes`). */
  readonly service: string;
  /** Holding ANY of these scopes lists the tool. */
  readonly anyOf: readonly string[];
  /** Why the write is not offered yet, in the owner's words. */
  readonly reason: string;
}

export const SCOPE_GATED_WRITES: Readonly<Record<string, ScopeGatedWrite>> = Object.freeze({
  gmail_thread_archive: {
    service: "gmail",
    anyOf: [GMAIL_MODIFY, GMAIL_FULL],
    reason: "re-authorise Gmail to grant gmail.modify",
  },
  // Connectors 0.20.0: a connection made while the consent asked only `calendar.readonly` lists
  // none of the three until `nimbus connector auth google_calendar` is run again.
  gcal_event_create: calendarWrite(),
  gcal_event_update: calendarWrite(),
  gcal_event_delete: calendarWrite(),
});

/**
 * The reason `toolId` is not offered because the token lacks its scope, or `undefined` when it is
 * offered or no claim can be made. `granted` maps a service to the credential's space-separated
 * scopes (`undefined` value: the credential records none); a service absent from `granted` (or no
 * map at all) makes no claim.
 */
export function scopeGatedReason(
  toolId: string,
  granted: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  if (!Object.hasOwn(SCOPE_GATED_WRITES, toolId)) return undefined;
  const gate = SCOPE_GATED_WRITES[toolId];
  if (gate === undefined || granted === undefined || !Object.hasOwn(granted, gate.service)) {
    return undefined;
  }
  const held = new Set((granted[gate.service] ?? "").split(/\s+/).filter((s) => s !== ""));
  return gate.anyOf.some((s) => held.has(s)) ? undefined : gate.reason;
}
