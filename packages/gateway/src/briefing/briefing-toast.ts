import type { BriefingCounts } from "../agents/_lib/briefing-types.ts";

/**
 * The text of the two local notifications (OR-10-11). COUNTS ONLY: both functions take numbers and
 * return fixed words around them, so no title, sender, repository, channel, schedule name or time can
 * reach a lock screen. The input types admit no string; a property test pins the output shape.
 */
export const BRIEFING_TOAST_TITLE = "Nimbus briefing";
export const DEADLINE_TOAST_TITLE = "Nimbus deadlines";
export const NOTHING_WAITING_TEXT = "Nothing is waiting for you today";

export type ToastText = { readonly title: string; readonly body: string };

function whole(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function part(n: number, one: string, many: string): string | null {
  const v = whole(n);
  if (v === 0) return null;
  return `${String(v)} ${v === 1 ? one : many}`;
}

export function briefingToastText(counts: BriefingCounts): ToastText {
  const parts = [
    part(counts.meetings, "meeting", "meetings"),
    part(counts.reviews, "review waiting", "reviews waiting"),
    part(counts.incidents, "active incident", "active incidents"),
    part(counts.ticketsDue, "ticket due or overdue", "tickets due or overdue"),
    part(counts.unreadMail, "unread mail thread", "unread mail threads"),
    part(counts.unreadChat, "unread chat thread", "unread chat threads"),
    whole(counts.onCallShifts) > 0 ? "on call today" : null,
  ].filter((p): p is string => p !== null);
  return {
    title: BRIEFING_TOAST_TITLE,
    body: parts.length === 0 ? NOTHING_WAITING_TEXT : parts.join(" · "),
  };
}

export function deadlineToastText(n: number, leadHours: number): ToastText {
  const count = whole(n);
  const hours = whole(leadHours);
  return {
    title: DEADLINE_TOAST_TITLE,
    body: `${String(count)} open ${count === 1 ? "item" : "items"} due within ${String(hours)} h with no recent activity`,
  };
}
