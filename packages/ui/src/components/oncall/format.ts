import type { PushSinkOutcome } from "../../ipc/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Coarse and never negative: a gateway clock ahead of ours reads "just now". */
export function formatAge(createdAt: number, nowMs: number): string {
  const d = nowMs - createdAt;
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  return `${Math.floor(d / DAY)} d ago`;
}

const SINK_ORDER = ["event", "toast", "chatops"];

export function orderedSinks(
  delivery: Readonly<Record<string, PushSinkOutcome>>,
): [string, PushSinkOutcome][] {
  const known = SINK_ORDER.filter((k) => k in delivery);
  const rest = Object.keys(delivery)
    .filter((k) => !SINK_ORDER.includes(k))
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...rest].map((k) => [k, delivery[k] as PushSinkOutcome]);
}
