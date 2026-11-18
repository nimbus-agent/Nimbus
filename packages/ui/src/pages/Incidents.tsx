import { type ReactNode, useCallback, useState } from "react";
import { useSearchParams } from "react-router";
import { PageHeader } from "../components/chrome/PageHeader";
import { asIncidentList } from "../components/incidents/guards";
import { IncidentDetail } from "../components/incidents/IncidentDetail";
import { IncidentFindings } from "../components/incidents/IncidentFindings";
import { IncidentList } from "../components/incidents/IncidentList";
import { safeText } from "../components/incidents/safe";
import { useIpcQuery } from "../hooks/useIpcQuery";

const NO_DATA =
  "No incident source is connected yet. Connect PagerDuty, Jira Service Management, Sentry, Monte Carlo or Bigeye, then sync.";

/**
 * Read-only (Phase 10 IC10a, IC10b): `incident.list`, `incident.get`, `incident.timeline`,
 * `incident.proposals` and `incident.findings`, and nothing else. Nothing here starts an action (§ 6).
 */
export function Incidents(): ReactNode {
  const [openOnly, setOpenOnly] = useState(true);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("id");
  const { data, error } = useIpcQuery<unknown>("incident.list", 60_000, {
    open: openOnly,
    cascade: true,
    limit: 50,
  });
  const list = asIncidentList(data);
  const onSelect = useCallback(
    (id: string) => {
      if (id !== selectedId) setParams({ id });
    },
    [selectedId, setParams],
  );
  return (
    <>
      <PageHeader title="Incidents" />
      <div className="p-6 space-y-4">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => setOpenOnly(e.target.checked)}
          />
          Open only
        </label>
        <IncidentFindings />
        {error !== null && list === null ? (
          <p role="alert" className="text-sm">
            {`Could not load incidents: ${safeText(error)}. From a terminal: nimbus incident list`}
          </p>
        ) : list === null ? (
          <p className="text-sm text-[var(--color-fg-muted)]">Loading...</p>
        ) : list.status === "no_data" ? (
          <p className="text-sm">{NO_DATA}</p>
        ) : list.records.length === 0 ? (
          <p className="text-sm">No incident records.</p>
        ) : (
          <div className="grid grid-cols-[minmax(220px,1fr)_2fr] gap-4">
            <div className="space-y-2">
              {list.groups === null && (
                <p className="text-xs">The cascade could not be read right now.</p>
              )}
              {(list.groups ?? []).length > 0 && (
                <p className="text-xs text-[var(--color-fg-muted)]">
                  {`${String((list.groups ?? []).length)} cascade group(s) among the open records.`}
                </p>
              )}
              <IncidentList
                records={list.records}
                selectedId={selectedId}
                onSelect={onSelect}
                nowMs={Date.now()}
              />
            </div>
            {selectedId === null ? (
              <p className="text-sm text-[var(--color-fg-muted)]">
                Select an incident to see its record and timeline.
              </p>
            ) : (
              <IncidentDetail key={selectedId} id={selectedId} />
            )}
          </div>
        )}
      </div>
    </>
  );
}
