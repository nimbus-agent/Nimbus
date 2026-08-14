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
