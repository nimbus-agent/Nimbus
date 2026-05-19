import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { PendingUpdates } from "../components/PendingUpdates";
import { useIpcQuery } from "../hooks/useIpcQuery";
import { createIpcClient } from "../ipc/client";
import type { ExtensionListResult, ExtensionSummary } from "../ipc/types";
import { useNimbusStore } from "../store";

interface ExtensionRowProps {
  ext: ExtensionSummary;
  disabled: boolean;
  onToggle: (ext: ExtensionSummary) => void;
  onRemove: (ext: ExtensionSummary) => void;
}

function ExtensionRow({ ext, disabled, onToggle, onRemove }: Readonly<ExtensionRowProps>) {
  return (
    <tr>
      <td className="py-2 px-3 font-mono text-sm">{ext.id}</td>
      <td className="py-2 px-3 text-sm">{ext.version}</td>
      <td className="py-2 px-3">
        <span
          data-testid="sandbox-badge"
          className="inline-block px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-700"
        >
          Process isolation
        </span>
      </td>
      <td className="py-2 px-3">
        <input
          type="checkbox"
          aria-label={`${ext.id} enabled`}
          checked={ext.enabled === 1}
          disabled={disabled}
          onChange={() => onToggle(ext)}
        />
      </td>
      <td className="py-2 px-3">
        <button
          type="button"
          aria-label={`Remove extension ${ext.id}`}
          disabled={disabled}
          onClick={() => onRemove(ext)}
          className="text-red-600 text-sm disabled:opacity-40"
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

export function Marketplace() {
  const connectionState = useNimbusStore((s) => s.connectionState);
  const offline = connectionState !== "connected";

  const { data, error, isLoading, refetch } = useIpcQuery<ExtensionListResult>(
    "extension.list",
    30_000,
  );

  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  async function handleToggle(ext: ExtensionSummary) {
    if (actionInFlight) return;
    setActionInFlight(ext.id);
    try {
      if (ext.enabled === 1) {
        await createIpcClient().extensionDisable(ext.id);
      } else {
        await createIpcClient().extensionEnable(ext.id);
      }
      refetch();
    } finally {
      setActionInFlight(null);
    }
  }

  async function handleRemove(ext: ExtensionSummary) {
    if (!globalThis.confirm(`Remove extension "${ext.id}"?`)) return;
    setActionInFlight(ext.id);
    try {
      await createIpcClient().extensionRemove(ext.id);
      refetch();
    } finally {
      setActionInFlight(null);
    }
  }

  async function handleInstall() {
    setInstallError(null);
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string" || picked.trim() === "") return;
    try {
      await createIpcClient().extensionInstall(picked);
      refetch();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Extensions</h1>
        <button
          type="button"
          disabled={offline}
          onClick={handleInstall}
          className="px-3 py-1 rounded bg-blue-600 text-white text-sm disabled:opacity-40"
        >
          Install from directory
        </button>
      </div>

      {isLoading && <p className="text-neutral-500 text-sm">Loading…</p>}
      {error && <p className="text-red-600 text-sm">{error}</p>}
      {installError && <p className="text-red-600 text-sm">{installError}</p>}

      <PendingUpdates offline={offline} />

      {data && (
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b text-sm text-neutral-500">
              <th className="py-2 px-3">ID</th>
              <th className="py-2 px-3">Version</th>
              <th className="py-2 px-3">Sandbox</th>
              <th className="py-2 px-3">Enabled</th>
              <th className="py-2 px-3" />
            </tr>
          </thead>
          <tbody>
            {data.extensions.map((ext) => (
              <ExtensionRow
                key={ext.id}
                ext={ext}
                disabled={offline || actionInFlight !== null}
                onToggle={handleToggle}
                onRemove={handleRemove}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
