import type { PushDelivery } from "./push-runner.ts";
import type { PushStore, SinkOutcome } from "./push-store.ts";

/** Spec § 2.5: briefs are ALL stored; only human interruptions are capped. */
export const PUSH_NOTIFY_CAP = 3;
const TITLE = "Nimbus on-call";

export interface PushSinkDeps {
  readonly store: PushStore;
  readonly notify: (title: string, body: string) => void | Promise<void>;
  readonly emit: (payload: { incidentId: string; status: "ok" | "failed" }) => void;
  readonly now: () => number;
}

function bodyFor(d: PushDelivery): string {
  return d.row.status === "ok"
    ? `${d.incident.title} — brief ready: nimbus oncall pushed ${d.row.incidentId}`
    : `${d.incident.title} — brief could not be assembled: nimbus oncall pushed ${d.row.incidentId}`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createPushDeliverer(
  deps: PushSinkDeps,
): (items: readonly PushDelivery[]) => Promise<void> {
  const record = (id: string, sink: string, o: Omit<SinkOutcome, "at">): void =>
    deps.store.recordDelivery(id, sink, { ...o, at: deps.now() });

  return async (items) => {
    // The event is a machine signal (the desktop panel needs every id) — never capped.
    for (const d of items) {
      try {
        deps.emit({ incidentId: d.row.incidentId, status: d.row.status });
        record(d.row.incidentId, "event", { outcome: "delivered" });
      } catch (e) {
        record(d.row.incidentId, "event", { outcome: "failed", reason: errText(e) });
      }
    }
    const newestFirst = [...items].sort(
      (a, b) => (b.incident.openedAtMs ?? 0) - (a.incident.openedAtMs ?? 0),
    );
    const shown = newestFirst.slice(0, PUSH_NOTIFY_CAP);
    for (const d of shown) {
      try {
        await deps.notify(TITLE, bodyFor(d));
        record(d.row.incidentId, "toast", { outcome: "delivered" });
      } catch (e) {
        record(d.row.incidentId, "toast", { outcome: "failed", reason: errText(e) });
      }
    }
    const rest = newestFirst.slice(PUSH_NOTIFY_CAP);
    if (rest.length === 0) return;
    try {
      await deps.notify(
        TITLE,
        `Briefs ready for ${items.length} P1 incidents (${PUSH_NOTIFY_CAP} shown) — nimbus oncall pushed list`,
      );
    } catch {
      // The summary has no row of its own; each coalesced row below still records its outcome.
    }
    for (const d of rest) record(d.row.incidentId, "toast", { outcome: "coalesced" });
  };
}
