import { useState } from "react";

import { useIpcQuery } from "../hooks/useIpcQuery";
import { createIpcClient } from "../ipc/client";

/**
 * T2 PR 3 — Marketplace "Pending updates" panel. Read-only against
 * `extension.checkForUpdates`; the Update button fires `extension.update`
 * which routes through HITL. Polls every 5 minutes (configurable via the
 * `pollIntervalMs` prop for tests).
 */
export interface AvailableUpdateUi {
  readonly id: string;
  readonly displayName: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly channel: "stable" | "beta";
  readonly publisherStatus: "verified" | "unverified";
  readonly verificationStatus: "verified" | "needs_sync" | "signature_failed";
}

export interface UpdateApplyResultUi {
  readonly applied: boolean;
  readonly reason?: string;
  readonly hint?: string;
}

interface PendingUpdatesProps {
  readonly offline: boolean;
  readonly pollIntervalMs?: number;
}

const DEFAULT_POLL_MS = 5 * 60_000;

export function PendingUpdates({
  offline,
  pollIntervalMs = DEFAULT_POLL_MS,
}: Readonly<PendingUpdatesProps>) {
  const { data, error, refetch } = useIpcQuery<AvailableUpdateUi[]>(
    "extension.checkForUpdates",
    pollIntervalMs,
    undefined,
    { enabled: !offline },
  );
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{
    id: string;
    result: UpdateApplyResultUi;
  } | null>(null);
  const [inFlight, setInFlight] = useState<string | null>(null);

  // Defensive coercion — `useIpcQuery<T>` doesn't enforce the runtime shape,
  // and a stale mock or schema regression could hand back a non-array. Render
  // nothing in that case instead of crashing the Marketplace page.
  const list: AvailableUpdateUi[] = Array.isArray(data) ? (data as AvailableUpdateUi[]) : [];

  async function handleApply(id: string, toVersion: string): Promise<void> {
    setApplyError(null);
    setApplyResult(null);
    setInFlight(id);
    try {
      const res = await createIpcClient().call<UpdateApplyResultUi>("extension.update", {
        id,
        toVersion,
      });
      setApplyResult({ id, result: res });
      // Refresh the cache after apply — the row is removed from the cache on success
      // and stays on failure.
      refetch();
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setInFlight(null);
    }
  }

  // Render nothing when offline, error from check (e.g. daemon not configured),
  // or no entries — keeps the Marketplace tidy when auto-update is dormant.
  if (offline) return null;
  if (error !== null) return null;
  if (list.length === 0) return null;

  return (
    <section
      data-testid="pending-updates"
      className="border rounded p-4 bg-amber-50 border-amber-300 flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">Pending updates</h2>
      {applyError !== null && (
        <p className="text-red-600 text-sm" data-testid="apply-error">
          {applyError}
        </p>
      )}
      {applyResult !== null && (
        <p
          className={`text-sm ${applyResult.result.applied ? "text-green-700" : "text-red-600"}`}
          data-testid={`apply-result-${applyResult.id}`}
        >
          {applyResult.result.applied
            ? `Updated ${applyResult.id}`
            : `Update failed: ${applyResult.result.reason}${
                applyResult.result.hint !== undefined ? ` — ${applyResult.result.hint}` : ""
              }`}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {list.map((u) => {
          const actionable = u.verificationStatus === "verified";
          const isInFlight = inFlight === u.id;
          return (
            <li
              key={u.id}
              data-testid={`pending-update-row-${u.id}`}
              className="flex items-center justify-between gap-3 border-b border-amber-200 pb-2"
            >
              <div className="flex flex-col">
                <span className="font-mono text-sm">
                  <strong>{u.displayName}</strong>{" "}
                  <span className="text-neutral-600">
                    {u.fromVersion} → {u.toVersion}
                  </span>
                </span>
                <span className="text-xs text-neutral-500 flex items-center gap-2">
                  <span className="px-1.5 py-0.5 rounded bg-neutral-200">{u.channel}</span>
                  <span
                    className={
                      u.publisherStatus === "verified" ? "text-green-700" : "text-amber-700"
                    }
                  >
                    publisher: {u.publisherStatus}
                  </span>
                  {u.verificationStatus === "needs_sync" && (
                    <span
                      data-testid={`needs-sync-${u.id}`}
                      className="px-1.5 py-0.5 rounded bg-amber-200 text-amber-900"
                    >
                      needs sync — run <code>nimbus extension sync</code>
                    </span>
                  )}
                  {u.verificationStatus === "signature_failed" && (
                    <span
                      data-testid={`signature-failed-${u.id}`}
                      className="px-1.5 py-0.5 rounded bg-red-200 text-red-900"
                    >
                      signature failed — contact publisher
                    </span>
                  )}
                </span>
              </div>
              <button
                type="button"
                aria-label={`Update ${u.id} to ${u.toVersion}`}
                data-testid={`update-button-${u.id}`}
                disabled={!actionable || isInFlight}
                onClick={() => {
                  void handleApply(u.id, u.toVersion);
                }}
                className="px-3 py-1 rounded bg-blue-600 text-white text-sm disabled:opacity-40"
              >
                {isInFlight ? "Updating…" : "Update"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
