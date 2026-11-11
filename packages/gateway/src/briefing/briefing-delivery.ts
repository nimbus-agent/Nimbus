import type { BriefingReadyPayload } from "../ipc/gateway-events.ts";
import type { ToastOutcome } from "../platform/notifications/notifications-runtime.ts";
import type { ToastText } from "./briefing-toast.ts";

/**
 * Where a composed briefing goes (OR-10-11: local only). Two sinks, both injected so a test substitutes
 * recorders: the `briefing.ready` gateway event (counts and headline only) and the OS toast (counts only).
 * Order is fixed: the event first, then the toast, so an observer that sees the toast can already read the
 * stored run. An emit that throws never stops the toast; a toast never rejects (`showWithOutcome`).
 */
export type BriefingDeliveryDeps = {
  readonly emit: (payload: BriefingReadyPayload) => void;
  readonly toast: (title: string, body: string) => Promise<ToastOutcome>;
};

export async function deliverBriefing(
  deps: BriefingDeliveryDeps,
  payload: BriefingReadyPayload,
  text: ToastText,
  toastEnabled: boolean,
): Promise<ToastOutcome> {
  try {
    deps.emit(payload);
  } catch {
    // An observer failing must not stop the notification.
  }
  if (!toastEnabled) return "demo";
  return await deps.toast(text.title, text.body);
}
