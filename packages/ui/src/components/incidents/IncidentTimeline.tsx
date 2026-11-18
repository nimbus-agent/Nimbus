import type { ReactNode } from "react";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import { asIncidentTimeline } from "./guards";
import { safeText, stamp } from "./safe";

export function IncidentTimeline({ recordId }: { readonly recordId: string }): ReactNode {
  const { data, error } = useIpcQuery<unknown>("incident.timeline", 60_000, { id: recordId });
  const tl = asIncidentTimeline(data);
  if (error !== null && tl === null) {
    return (
      <p role="alert" className="text-sm">
        {`Could not load the timeline: ${safeText(error)}. From a terminal: nimbus incident show ${safeText(recordId, 120)}`}
      </p>
    );
  }
  if (tl === null || tl.recordId !== recordId) {
    return <p className="text-sm text-[var(--color-fg-muted)]">Loading timeline...</p>;
  }
  return (
    <section aria-label="Timeline" className="space-y-2">
      <h3 className="text-sm font-medium">Timeline</h3>
      {tl.events.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-muted)]">No events are known for this record.</p>
      ) : (
        <ol className="space-y-1 text-xs">
          {tl.events.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: events carry no id; the list is read-only and never reordered
            <li key={i} className="flex gap-2">
              <span className="font-mono shrink-0">
                {`${stamp(e.atMs)}${e.atBasis === "observed" ? " (observed)" : ""}`}
              </span>
              <span className="text-[var(--color-fg-muted)] shrink-0">{safeText(e.kind, 40)}</span>
              <span>{safeText(e.text, 400)}</span>
              {e.rule !== null && (
                <span className="text-[var(--color-fg-muted)]">{`[${safeText(e.rule, 60)}]`}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {tl.notes.map((n, i) => (
        <p key={`${String(i)}-${n}`} className="text-xs text-[var(--color-fg-muted)]">
          {safeText(n, 400)}
        </p>
      ))}
    </section>
  );
}
