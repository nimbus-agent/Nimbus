import type { ReactNode } from "react";
import type { IncidentSummary } from "../../ipc/types";
import { formatAge } from "../oncall/format";
import { safeText } from "./safe";

export function IncidentList(props: {
  readonly records: readonly IncidentSummary[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly nowMs: number;
}): ReactNode {
  return (
    <ul
      aria-label="Incidents"
      className="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded-md"
    >
      {props.records.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            aria-current={r.id === props.selectedId ? "true" : undefined}
            onClick={() => props.onSelect(r.id)}
            className={`w-full text-left px-3 py-2 text-xs ${r.id === props.selectedId ? "bg-[rgba(120,144,255,0.15)]" : ""}`}
          >
            <div className="text-[var(--color-fg)] truncate">{safeText(r.title, 160)}</div>
            <div className="flex gap-2 text-[var(--color-fg-muted)]">
              {r.service !== null && <span>{safeText(r.service, 60)}</span>}
              {r.severity !== null && <span>{safeText(r.severity, 20)}</span>}
              <span
                className={
                  r.status === "open" ? "text-[var(--color-error)]" : "text-[var(--color-ok)]"
                }
              >
                {safeText(r.status, 20)}
              </span>
              {r.openedAtMs !== null && (
                <span className="ml-auto">{formatAge(r.openedAtMs, props.nowMs)}</span>
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
