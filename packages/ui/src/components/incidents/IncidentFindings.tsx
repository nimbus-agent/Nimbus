import type { ReactNode } from "react";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import { asIncidentFindings } from "./guards";
import { isRecord, safeText, stamp } from "./safe";

/** A finding's detail as `key: value` text, in key order; nested values are not expanded. */
export function detailText(detail: unknown): string {
  if (!isRecord(detail)) return "";
  return Object.keys(detail)
    .sort((a, b) => (a < b ? -1 : Number(a > b)))
    .map((k) => {
      const v = detail[k];
      const shown = v === null || typeof v !== "object" ? String(v) : "(not shown)";
      return `${safeText(k, 40)}: ${safeText(shown, 120)}`;
    })
    .join(", ");
}

/** Read-only (IC10b): the open findings of the expectation radar and the anomaly baseline (IC8). */
export function IncidentFindings(): ReactNode {
  const { data, error } = useIpcQuery<unknown>("incident.findings", 60_000, { limit: 50 });
  const res = asIncidentFindings(data);
  if (error !== null && res === null) {
    return (
      <p role="alert" className="text-sm">
        {`Could not load the findings: ${safeText(error)}. From a terminal: nimbus incident findings`}
      </p>
    );
  }
  if (res === null) return null;
  return (
    <section aria-label="Findings" className="space-y-1">
      <h2 className="text-sm font-medium">Findings</h2>
      {res.findings.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-muted)]">No open findings.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {res.findings.map((f) => (
            <li key={f.id}>
              {`${safeText(f.kind, 20)} - ${safeText(f.service ?? "no service", 80)} - ${safeText(f.key, 120)} - since ${stamp(f.openedAtMs)}, last seen ${stamp(f.lastSeenAtMs)}`}
              <span className="block text-[var(--color-fg-muted)]">{detailText(f.detail)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
