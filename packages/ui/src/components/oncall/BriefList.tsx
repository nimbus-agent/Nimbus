import type { ReactNode } from "react";
import type { PushedBriefSummary } from "../../ipc/types";
import { formatAge } from "./format";

export function BriefList(props: {
  readonly briefs: readonly PushedBriefSummary[];
  readonly selectedId: string | null;
  readonly onSelect: (incidentId: string) => void;
  readonly nowMs: number;
}): ReactNode {
  return (
    <ul
      aria-label="Pushed briefs"
      className="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded-md"
    >
      {props.briefs.map((b) => (
        <li key={b.incidentId}>
          <button
            type="button"
            aria-current={b.incidentId === props.selectedId ? "true" : undefined}
            onClick={() => props.onSelect(b.incidentId)}
            className={`w-full text-left px-3 py-2 text-xs ${b.incidentId === props.selectedId ? "bg-[rgba(120,144,255,0.15)]" : ""}`}
          >
            <div className="text-[var(--color-fg)] truncate">{b.title ?? b.incidentId}</div>
            <div className="flex gap-2 text-[var(--color-fg-muted)]">
              {b.service !== null && <span>{b.service}</span>}
              <span
                className={
                  b.status === "ok" ? "text-[var(--color-ok)]" : "text-[var(--color-error)]"
                }
              >
                {b.status === "ok" ? "ready" : "failed"}
              </span>
              <span className="ml-auto">{formatAge(b.createdAt, props.nowMs)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
