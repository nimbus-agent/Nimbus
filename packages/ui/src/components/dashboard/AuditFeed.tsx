import type { ReactNode } from "react";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import type { AuditEntry } from "../../ipc/types";

function formatTime(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime())
    ? "--:--"
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function outcomeColour(o: AuditEntry["hitlStatus"]): string {
  switch (o) {
    case "approved":
      return "text-[var(--color-ok)]";
    case "rejected":
      return "text-[var(--color-error)]";
    case "not_required":
      return "text-[var(--color-accent)]";
    default:
      return "text-[var(--color-fg-muted)]";
  }
}

function extractSubject(actionJson: string): string | undefined {
  if (actionJson === "" || actionJson === "{}") return undefined;
  try {
    const parsed = JSON.parse(actionJson) as unknown;
    if (parsed !== null && typeof parsed === "object" && "subject" in parsed) {
      const subject = (parsed as { subject: unknown }).subject;
      if (typeof subject === "string" && subject !== "") return subject;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function AuditFeed(): ReactNode {
  const { data } = useIpcQuery<AuditEntry[]>("audit.list", 10_000, { limit: 25 });
  const entries = data ?? [];
  if (entries.length === 0) {
    return (
      <section aria-label="Recent activity" className="text-[var(--color-fg-muted)] text-sm">
        No recent activity.
      </section>
    );
  }
  return (
    <section
      aria-label="Recent activity"
      className="max-h-80 overflow-auto border border-[var(--color-border)] rounded-md"
    >
      <ul className="divide-y divide-[var(--color-border)]">
        {entries.map((e) => {
          const subject = extractSubject(e.actionJson);
          return (
            <li key={e.id} className="px-3 py-2 flex items-center gap-3 text-xs">
              <time className="text-[var(--color-fg-muted)] w-12 font-mono">
                {formatTime(e.timestamp)}
              </time>
              <span className="text-[var(--color-fg)]">{e.actionType}</span>
              {subject !== undefined && (
                <span className="text-[var(--color-fg-muted)] truncate">{subject}</span>
              )}
              <span className={`ml-auto ${outcomeColour(e.hitlStatus)}`}>{e.hitlStatus}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
