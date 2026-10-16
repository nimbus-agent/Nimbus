import type { ReactNode } from "react";
import { Link } from "react-router";
import type { CaptureSummary } from "../../ipc/types";
import { showInvisible } from "../../lib/escape-invisible";
import { formatAge } from "../oncall/format";
import { formatTimeLeft } from "./format";

/**
 * Rows are LINKS to `?id=`, not buttons: a row names its state ("revoked", "rejected"), and the page
 * holds itself to having no button that reads like an owner verb. Re-clicking the open row navigates
 * to the same location, which react-router turns into a replace rather than a duplicate entry.
 */
export function CaptureList(props: {
  readonly captures: readonly CaptureSummary[];
  readonly selectedId: string | null;
  readonly nowMs: number;
}): ReactNode {
  return (
    <ul
      aria-label="Captures"
      className="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded-md"
    >
      {props.captures.map((c) => (
        <li key={c.id}>
          <Link
            to={{ search: `?id=${encodeURIComponent(c.id)}` }}
            aria-current={c.id === props.selectedId ? "true" : undefined}
            className={`block w-full text-left px-3 py-2 text-xs ${c.id === props.selectedId ? "bg-[rgba(120,144,255,0.15)]" : ""}`}
          >
            <div className="text-[var(--color-fg)] truncate">
              {c.title === "" ? c.id : showInvisible(c.title)}
            </div>
            <div className="flex flex-wrap gap-2 text-[var(--color-fg-muted)]">
              <span>{c.kind}</span>
              <span>{c.state}</span>
              {c.clientLabel !== null && <span>{showInvisible(c.clientLabel)}</span>}
              {c.kind === "action" && c.state === "proposed" && c.expiresAt !== null && (
                <span>{formatTimeLeft(c.expiresAt, props.nowMs)}</span>
              )}
              <span className="ml-auto">{formatAge(c.createdAt, props.nowMs)}</span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
