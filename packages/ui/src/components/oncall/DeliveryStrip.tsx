import type { ReactNode } from "react";
import type { PushSinkOutcome } from "../../ipc/types";
import { orderedSinks } from "./format";

export function DeliveryStrip({
  delivery,
}: {
  readonly delivery: Readonly<Record<string, PushSinkOutcome>>;
}): ReactNode {
  const sinks = orderedSinks(delivery);
  if (sinks.length === 0) return null;
  return (
    <ul aria-label="Delivery" className="flex flex-wrap gap-2 text-xs">
      {sinks.map(([sink, o]) => (
        <li key={sink} className="px-2 py-1 rounded border border-[var(--color-border)]">
          <span className="text-[var(--color-fg)]">{`${sink}: ${o.outcome}`}</span>
          {o.reason !== undefined && o.reason !== "" && (
            <span className="ml-1 text-[var(--color-fg-muted)]">{o.reason}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
