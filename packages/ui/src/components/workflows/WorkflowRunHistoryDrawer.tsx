import { useEffect, useState } from "react";
import { Link } from "react-router";
import { createIpcClient } from "../../ipc/client";
import type { WorkflowRunHistoryEntry } from "../../ipc/types";

interface WorkflowRunHistoryDrawerProps {
  readonly workflowName: string;
  readonly onClose: () => void;
  readonly colSpan: number;
}

const HISTORY_LIMIT = 10;

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

function statusColor(status: string, dryRun: boolean): string {
  if (dryRun) return "text-amber-600 italic";
  if (status === "error") return "text-red-600";
  if (status === "done") return "text-green-700";
  return "text-neutral-600";
}

function formatStatus(status: string, dryRun: boolean): string {
  return dryRun ? `preview (${status})` : status;
}

export function WorkflowRunHistoryDrawer({
  workflowName,
  onClose,
  colSpan,
}: WorkflowRunHistoryDrawerProps) {
  const [runs, setRuns] = useState<ReadonlyArray<WorkflowRunHistoryEntry> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    createIpcClient()
      .workflowListRuns(workflowName, HISTORY_LIMIT)
      .then((res) => {
        if (!cancelled) setRuns(res.runs);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workflowName]);

  return (
    <tr>
      <td colSpan={colSpan} className="py-2 px-3 bg-neutral-50 dark:bg-neutral-900">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold">Last {HISTORY_LIMIT} runs</span>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-neutral-500 hover:text-neutral-700"
          >
            Close
          </button>
        </div>
        {error && <p className="text-red-600 text-xs">{error}</p>}
        {runs === null && !error && <p className="text-xs text-neutral-500">Loading…</p>}
        {runs !== null && runs.length === 0 && (
          <p className="text-xs text-neutral-500">No runs yet.</p>
        )}
        {runs !== null && runs.length > 0 && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-neutral-500">
                <th className="text-left px-2 py-1">Started</th>
                <th className="text-left px-2 py-1">Duration</th>
                <th className="text-left px-2 py-1">Status</th>
                <th className="text-left px-2 py-1">Audit</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="px-2 py-1 font-mono">{formatTimestamp(r.startedAt)}</td>
                  <td className="px-2 py-1 font-mono">
                    {r.durationMs === null ? "—" : `${r.durationMs} ms`}
                  </td>
                  <td className={`px-2 py-1 ${statusColor(r.status, r.dryRun)}`}>
                    {formatStatus(r.status, r.dryRun)}
                  </td>
                  <td className="px-2 py-1">
                    <Link
                      to={`/settings/audit?runId=${encodeURIComponent(r.id)}`}
                      className="text-blue-600 hover:underline"
                    >
                      View audit entry
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </td>
    </tr>
  );
}
