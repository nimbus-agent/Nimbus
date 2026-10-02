import type { OncallBriefPushedPayload } from "../ipc/gateway-events.ts";
import type { PushDelivery } from "./push-runner.ts";
import type { PushStore, SinkOutcome } from "./push-store.ts";

/** Spec § 2.5: briefs are ALL stored; only human interruptions are capped. */
export const PUSH_NOTIFY_CAP = 3;
const TITLE = "Nimbus on-call";

export interface PushSinkDeps {
  readonly store: PushStore;
  readonly notify: (title: string, body: string) => void | Promise<void>;
  readonly emit: (payload: OncallBriefPushedPayload) => void;
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

type Attempt = Omit<SinkOutcome, "at">;

/** The outcome comes from the sink attempt ALONE; recording it is a separate, guarded step. */
async function attempt(run: () => void | Promise<void>): Promise<Attempt> {
  try {
    await run();
    return { outcome: "delivered" };
  } catch (e) {
    return { outcome: "failed", reason: errText(e) };
  }
}

export function createPushDeliverer(
  deps: PushSinkDeps,
): (items: readonly PushDelivery[]) => Promise<void> {
  // Never throws: a record failure must neither change an outcome nor stop a later sink.
  const record = (id: string, sink: string, o: Attempt): void => {
    try {
      deps.store.recordDelivery(id, sink, { ...o, at: deps.now() });
    } catch {
      // Swallowed by design (spec § 2.5): the sink already ran; the row is best-effort.
    }
  };

  return async (items) => {
    // The event is a machine signal (the desktop panel needs every id) — never capped.
    for (const d of items) {
      const o = await attempt(() =>
        deps.emit({ incidentId: d.row.incidentId, status: d.row.status }),
      );
      record(d.row.incidentId, "event", o);
    }
    const newestFirst = [...items].sort(
      (a, b) => (b.incident.openedAtMs ?? 0) - (a.incident.openedAtMs ?? 0),
    );
    for (const d of newestFirst.slice(0, PUSH_NOTIFY_CAP)) {
      const o = await attempt(() => deps.notify(TITLE, bodyFor(d)));
      record(d.row.incidentId, "toast", o);
    }
    const rest = newestFirst.slice(PUSH_NOTIFY_CAP);
    if (rest.length === 0) return;
    const summary = await attempt(() =>
      deps.notify(
        TITLE,
        `Briefs ready for ${items.length} P1 incidents (${PUSH_NOTIFY_CAP} shown) — nimbus oncall pushed list`,
      ),
    );
    const coalesced: Attempt =
      summary.outcome === "delivered"
        ? { outcome: "coalesced" }
        : { outcome: "coalesced", reason: `summary toast failed: ${summary.reason ?? ""}` };
    for (const d of rest) record(d.row.incidentId, "toast", coalesced);
  };
}
