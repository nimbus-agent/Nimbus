import { usableActorEmail } from "./actor-email.ts";
import { asRecord, stringField } from "./unknown-record.ts";

/**
 * Bumped whenever an incident row must be re-fetched to gain indexed depth.
 * Read by `ipc/index-rebody-rpc.ts`'s `REBODY_REQUIRED_META_VERSION`, which is
 * why this lives in a pure module: the IPC layer must not import a sync module.
 *
 * 1 — assignee/resolver attribution (Spec B).
 */
export const PAGERDUTY_INCIDENT_META_VERSION = 1;

/**
 * A PagerDuty actor reference that is a SERVICE rather than a person — an
 * auto-acknowledge or auto-resolve. Attributes to nobody, and must not be
 * counted as an attribution failure: nothing was lost.
 */
function isServiceActor(actor: Record<string, unknown>): boolean {
  const type = stringField(actor, "type") ?? "";
  return type.startsWith("service");
}

/** The expanded user objects on one incident, from both actor collections. */
function actorsOnIncident(row: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const assignments = row["assignments"];
  if (Array.isArray(assignments)) {
    for (const a of assignments) {
      const assignee = asRecord(asRecord(a)?.["assignee"]);
      if (assignee !== undefined) out.push(assignee);
    }
  }
  const acks = row["acknowledgements"];
  if (Array.isArray(acks)) {
    for (const a of acks) {
      const acker = asRecord(asRecord(a)?.["acknowledger"]);
      if (acker !== undefined) out.push(acker);
    }
  }
  return out;
}

/**
 * Harvest `user id -> email` from every EXPANDED actor across one page.
 *
 * Acknowledgers are harvested even though this spec emits no acknowledger edge.
 * They are an identity SOURCE only: `last_status_change_by` arrives as a bare
 * reference, and cross-referencing it against this map is what resolves a
 * responder who acknowledged and resolved but was never assigned — without
 * spending a request. Fetching a field for identity while declining to make a
 * claim from it is deliberate (spec § 3.2).
 */
export function pagerdutyEmailMapFromIncidents(incidents: readonly unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of incidents) {
    const row = asRecord(raw);
    if (row === undefined) continue;
    for (const actor of actorsOnIncident(row)) {
      if (isServiceActor(actor)) continue;
      const id = stringField(actor, "id");
      if (id === undefined || id === "") continue;
      const email = usableActorEmail(actor["email"]);
      if (email !== null && !map.has(id)) map.set(id, email);
    }
  }
  return map;
}

/**
 * `assignments[]` is caller-controlled and unbounded. Ten is generous for a
 * real incident; beyond it the extras are COUNTED as unattributed rather than
 * dropped, so a truncated list can never read as an exhaustive one.
 */
export const MAX_ASSIGNEES_PER_INCIDENT = 10;

export type PagerdutyIncidentActors = {
  readonly assigneeEmails: string[];
  readonly resolvedByEmail: string | null;
  /** Actors seen but not attributable. Service actors are NOT counted here. */
  readonly unattributed: number;
};

/** The resolver reference, but only for an incident that is actually resolved. */
function resolverRef(row: Record<string, unknown>): Record<string, unknown> | undefined {
  if (stringField(row, "status") !== "resolved") return undefined;
  return asRecord(row["last_status_change_by"]);
}

/** An actor's email: its own expanded field first, then the page-wide map. */
function emailForActor(
  actor: Record<string, unknown>,
  emailById: ReadonlyMap<string, string>,
): string | null {
  const own = usableActorEmail(actor["email"]);
  if (own !== null) return own;
  const id = stringField(actor, "id");
  if (id === undefined || id === "") return null;
  return emailById.get(id) ?? null;
}

export function extractPagerdutyActors(
  row: Record<string, unknown>,
  emailById: ReadonlyMap<string, string>,
): PagerdutyIncidentActors {
  const assigneeEmails: string[] = [];
  let unattributed = 0;

  const assignments = Array.isArray(row["assignments"]) ? row["assignments"] : [];
  for (const a of assignments) {
    const assignee = asRecord(asRecord(a)?.["assignee"]);
    if (assignee === undefined || isServiceActor(assignee)) continue;
    const email = emailForActor(assignee, emailById);
    if (email === null) {
      unattributed += 1;
      continue;
    }
    if (assigneeEmails.includes(email)) continue;
    if (assigneeEmails.length >= MAX_ASSIGNEES_PER_INCIDENT) {
      unattributed += 1;
      continue;
    }
    assigneeEmails.push(email);
  }

  let resolvedByEmail: string | null = null;
  const resolver = resolverRef(row);
  // A service resolver (auto-resolve) attributes to nobody and is NOT a
  // failure — nothing was lost, so it must not inflate `unattributed`.
  if (resolver !== undefined && !isServiceActor(resolver)) {
    resolvedByEmail = emailForActor(resolver, emailById);
    if (resolvedByEmail === null) unattributed += 1;
  }

  return { assigneeEmails, resolvedByEmail, unattributed };
}

/**
 * Actor ids on this page that still have no email — the only ids worth spending
 * a `/users/{id}` request on. Service actors are excluded so an auto-resolving
 * tenant never burns the lookup budget.
 */
export function pagerdutyUnresolvedActorIds(
  incidents: readonly unknown[],
  emailById: ReadonlyMap<string, string>,
): string[] {
  const ids = new Set<string>();
  for (const raw of incidents) {
    const row = asRecord(raw);
    if (row === undefined) continue;
    const candidates = [...actorsOnIncident(row)];
    const resolver = resolverRef(row);
    if (resolver !== undefined) candidates.push(resolver);
    for (const actor of candidates) {
      if (isServiceActor(actor)) continue;
      if (usableActorEmail(actor["email"]) !== null) continue;
      const id = stringField(actor, "id");
      if (id === undefined || id === "" || emailById.has(id)) continue;
      ids.add(id);
    }
  }
  return [...ids];
}
