import type { OncallBriefPushedPayload } from "../ipc/gateway-events.ts";
import { renderPushHeadline, renderPushSummary } from "./push-headline.ts";
import type { PushDelivery } from "./push-runner.ts";
import type { PushStore, SinkOutcome } from "./push-store.ts";

/** Posts one headline to the configured namespace; resolves to the number of channels posted to. */
export type ChatopsPoster = (text: string) => Promise<number>;

/** Spec § 2.5: briefs are ALL stored; only human interruptions are capped. */
export const PUSH_NOTIFY_CAP = 3;
const TITLE = "Nimbus on-call";
export const NO_NOTIFIER_REASON = "no OS notification implementation on this platform";
export const NO_NAMESPACE_REASON = "no [oncall.push] chatops_namespace";
export const CHATOPS_NOT_RUNNING_REASON = "ChatOps not running";
const noChannelsReason = (ns: string): string => `namespace ${ns} has no notify channels`;

export interface ChatopsSinkDeps {
  /** `[oncall.push] chatops_namespace`; `""` means not configured. */
  readonly namespace: string;
  /**
   * Read at DELIVERY time, never at construction: the runtime builds the deliverer before ChatOps
   * boots and binds the poster later (spec § 2.1). `undefined` means ChatOps is not running.
   */
  readonly post: () => ChatopsPoster | undefined;
}

export interface PushSinkDeps {
  readonly store: PushStore;
  readonly notify: (title: string, body: string) => void | Promise<void>;
  /**
   * Mirrors `NotificationService.delivers`: absent means true. `false` means `notify` would drop
   * the notification, so no toast is attempted and every row's toast is recorded `skipped`.
   */
  readonly notifyDelivers?: boolean;
  readonly emit: (payload: OncallBriefPushedPayload) => void;
  readonly now: () => number;
  /** Absent: no chatops sink and no `chatops` delivery record (PR 1 callers). */
  readonly chatops?: ChatopsSinkDeps;
  /** Spec § 4: a `failed` chat outcome is also logged. Fields never carry the headline text. */
  readonly warn?: (msg: string, fields: Record<string, string>) => void;
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

/** Like `attempt`, but a post that reached 0 channels is `skipped`, and any throw may be partial. */
async function chatAttempt(
  post: ChatopsPoster,
  render: () => string,
  ns: string,
): Promise<Attempt> {
  try {
    const sent = await post(render());
    return sent === 0
      ? { outcome: "skipped", reason: noChannelsReason(ns) }
      : { outcome: "delivered" };
  } catch (e) {
    return { outcome: "failed", reason: `${errText(e)} (delivery may be partial)` };
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

  const warnFailed = (incidentId: string, reason: string | undefined): void => {
    try {
      deps.warn?.("[oncall.push] chatops post failed", { incidentId, reason: reason ?? "" });
    } catch {
      // A logger that throws must not stop the remaining sinks.
    }
  };

  const chatSink = async (
    c: ChatopsSinkDeps,
    items: readonly PushDelivery[],
    newestFirst: readonly PushDelivery[],
  ): Promise<void> => {
    const skipAll = (reason: string): void => {
      for (const d of items) record(d.row.incidentId, "chatops", { outcome: "skipped", reason });
    };
    if (c.namespace === "") return skipAll(NO_NAMESPACE_REASON);
    let post: ChatopsPoster | undefined;
    try {
      post = c.post();
    } catch {
      post = undefined; // A throwing getter reads as "not running"; nothing escapes deliver.
    }
    if (post === undefined) return skipAll(CHATOPS_NOT_RUNNING_REASON);
    for (const d of newestFirst.slice(0, PUSH_NOTIFY_CAP)) {
      const o = await chatAttempt(post, () => renderPushHeadline(d), c.namespace);
      record(d.row.incidentId, "chatops", o);
      if (o.outcome === "failed") warnFailed(d.row.incidentId, o.reason);
    }
    const rest = newestFirst.slice(PUSH_NOTIFY_CAP);
    if (rest.length === 0) return;
    const s = await chatAttempt(post, () => renderPushSummary(items, rest), c.namespace);
    const o: Attempt =
      s.outcome === "delivered"
        ? { outcome: "coalesced" }
        : s.outcome === "skipped"
          ? s
          : { outcome: "coalesced", reason: `summary post failed: ${s.reason ?? ""}` };
    for (const d of rest) {
      record(d.row.incidentId, "chatops", o);
      if (s.outcome === "failed") warnFailed(d.row.incidentId, o.reason);
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
    // Spec § 2.2: BEFORE the toast's "no notifier" early return, so chat does not depend on it.
    if (deps.chatops !== undefined) await chatSink(deps.chatops, items, newestFirst);
    if (deps.notifyDelivers === false) {
      // Honest record: nothing would be shown, so nothing is attempted and no summary is sent.
      for (const d of items) {
        record(d.row.incidentId, "toast", { outcome: "skipped", reason: NO_NOTIFIER_REASON });
      }
      return;
    }
    for (const d of newestFirst.slice(0, PUSH_NOTIFY_CAP)) {
      const o = await attempt(() => deps.notify(TITLE, bodyFor(d)));
      record(d.row.incidentId, "toast", o);
    }
    const rest = newestFirst.slice(PUSH_NOTIFY_CAP);
    if (rest.length === 0) return;
    // Counts only rows whose brief was actually assembled; a failed row is paged, not "ready".
    const ready = items.filter((d) => d.row.status === "ok").length;
    const summary = await attempt(() =>
      deps.notify(
        TITLE,
        `${items.length} P1 incidents paged (${ready} brief${ready === 1 ? "" : "s"} ready) — nimbus oncall pushed list`,
      ),
    );
    const coalesced: Attempt =
      summary.outcome === "delivered"
        ? { outcome: "coalesced" }
        : { outcome: "coalesced", reason: `summary toast failed: ${summary.reason ?? ""}` };
    for (const d of rest) record(d.row.incidentId, "toast", coalesced);
  };
}
