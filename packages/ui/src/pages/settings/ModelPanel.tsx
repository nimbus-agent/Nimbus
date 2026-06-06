import { useCallback, useEffect, useMemo, useState } from "react";
import { PullDialog } from "../../components/settings/model/PullDialog";
import { RouterStatus } from "../../components/settings/model/RouterStatus";
import { PanelError } from "../../components/settings/PanelError";
import { PanelHeader } from "../../components/settings/PanelHeader";
import { StaleChip } from "../../components/settings/StaleChip";
import { createIpcClient } from "../../ipc/client";
import type {
  JsonRpcNotification,
  LlmModelInfo,
  LlmModelLoadPayload,
  LlmPullProgressPayload,
  LlmPullTerminalPayload,
  LlmTaskType,
} from "../../ipc/types";
import { useNimbusStore } from "../../store";

const TASK_OPTIONS: ReadonlyArray<{ value: "" | LlmTaskType; label: string }> = [
  { value: "", label: "Set default for…" },
  { value: "classification", label: "classification" },
  { value: "reasoning", label: "reasoning" },
  { value: "summarisation", label: "summarisation" },
  { value: "agent_step", label: "agent_step" },
];

function loadedKeyFor(m: LlmModelInfo): string {
  return `${m.provider}:${m.modelName}`;
}

export function ModelPanel() {
  const [models, setModels] = useState<ReadonlyArray<LlmModelInfo>>([]);
  const routerStatus = useNimbusStore((s) => s.routerStatus);
  const loadedKeys = useNimbusStore((s) => s.loadedKeys);
  const activePullId = useNimbusStore((s) => s.activePullId);
  const pullProgress = useNimbusStore((s) => s.pullProgress);
  const setRouterStatus = useNimbusStore((s) => s.setRouterStatus);
  const patchLoaded = useNimbusStore((s) => s.patchLoaded);
  const upsertPullProgress = useNimbusStore((s) => s.upsertPullProgress);
  const clearPullProgress = useNimbusStore((s) => s.clearPullProgress);
  const setActivePullId = useNimbusStore((s) => s.setActivePullId);
  const connectionState = useNimbusStore((s) => s.connectionState);

  const [fetchError, setFetchError] = useState<string | null>(null);
  const [pullOpen, setPullOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const offline = connectionState === "disconnected";
  const writeDisabled = offline;

  const refresh = useCallback(async () => {
    try {
      const [{ models: ms }, rs] = await Promise.all([
        createIpcClient().llmListModels(),
        createIpcClient().llmGetRouterStatus(),
      ]);
      setModels(ms);
      setRouterStatus(rs);
      setFetchError(null);
    } catch (e) {
      setFetchError((e as Error).message);
    }
  }, [setRouterStatus]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const onNotification = useCallback(
    (n: JsonRpcNotification) => {
      if (n.method === "llm.modelLoaded") {
        const p = n.params as LlmModelLoadPayload;
        patchLoaded(p.provider, p.modelName, true);
        return;
      }
      if (n.method === "llm.modelUnloaded") {
        const p = n.params as LlmModelLoadPayload;
        patchLoaded(p.provider, p.modelName, false);
        return;
      }
      if (n.method === "llm.pullProgress") {
        upsertPullProgress(n.params as LlmPullProgressPayload); // NOSONAR S4325: n.params is unknown; narrowed to the typed notification payload
        return;
      }
      if (n.method === "llm.pullCompleted" || n.method === "llm.pullFailed") {
        const p = n.params as LlmPullTerminalPayload;
        clearPullProgress(p.pullId);
        setActivePullId(null);
        if (n.method === "llm.pullCompleted") refresh().catch(() => undefined);
      }
    },
    [clearPullProgress, patchLoaded, refresh, setActivePullId, upsertPullProgress],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    createIpcClient()
      .subscribe(onNotification)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [onNotification]);

  const onLoad = useCallback(async (m: LlmModelInfo) => {
    if (m.provider === "remote") return;
    const key = loadedKeyFor(m);
    setBusyKey(key);
    try {
      await createIpcClient().llmLoadModel(m.provider, m.modelName);
    } finally {
      setBusyKey(null);
    }
  }, []);

  const onUnload = useCallback(async (m: LlmModelInfo) => {
    if (m.provider === "remote") return;
    const key = loadedKeyFor(m);
    setBusyKey(key);
    try {
      await createIpcClient().llmUnloadModel(m.provider, m.modelName);
    } finally {
      setBusyKey(null);
    }
  }, []);

  const onSetDefault = useCallback(
    async (m: LlmModelInfo, taskType: LlmTaskType) => {
      await createIpcClient().llmSetDefault(taskType, m.provider, m.modelName);
      await refresh();
    },
    [refresh],
  );

  const activeRow = activePullId === null ? undefined : pullProgress[activePullId];
  const activePercent = useMemo(() => {
    if (
      activeRow?.completedBytes === undefined ||
      activeRow.totalBytes === undefined ||
      activeRow.totalBytes === 0
    )
      return 0;
    return Math.min(100, Math.round((activeRow.completedBytes / activeRow.totalBytes) * 100));
  }, [activeRow]);

  return (
    <section className="p-6 space-y-6">
      <PanelHeader
        title="Model"
        description="Installed local models, task-type defaults, and router decisions."
        livePill={offline ? <StaleChip /> : undefined}
      />
      {fetchError !== null && (
        <PanelError message={`Failed to load model status: ${fetchError}`} onRetry={refresh} />
      )}

      {routerStatus !== null && <RouterStatus status={routerStatus} />}

      {activeRow !== undefined && (
        <div
          data-testid="active-pull-banner"
          className="rounded-md border border-[var(--color-border)] p-3 text-sm"
        >
          Pulling <span className="font-medium">{activeRow.modelName}</span> via{" "}
          {activeRow.provider} — {activePercent}%
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setPullOpen(true)}
          disabled={writeDisabled}
          className="px-3 py-1 rounded border border-[var(--color-border)] disabled:opacity-50"
        >
          Pull new model…
        </button>
      </div>

      <ul className="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded-md">
        {models.map((m) => {
          const key = loadedKeyFor(m);
          const loaded = loadedKeys[key] === true;
          const busy = busyKey === key;
          return (
            <li key={key} className="flex items-center gap-3 px-4 py-3">
              <span className="font-medium w-64 truncate">{m.modelName}</span>
              <span className="text-xs text-[var(--color-text-muted)] w-20">{m.provider}</span>
              {loaded ? (
                <button
                  type="button"
                  disabled={writeDisabled || busy || m.provider === "remote"}
                  onClick={() => onUnload(m)}
                  aria-label={`Unload ${m.modelName}`}
                  className="px-2 py-1 text-sm rounded border border-[var(--color-border)] disabled:opacity-50"
                >
                  Unload
                </button>
              ) : (
                <button
                  type="button"
                  disabled={writeDisabled || busy || m.provider === "remote"}
                  onClick={() => onLoad(m)}
                  aria-label={`Load ${m.modelName}`}
                  className="px-2 py-1 text-sm rounded border border-[var(--color-border)] disabled:opacity-50"
                >
                  Load
                </button>
              )}
              <select
                defaultValue=""
                disabled={writeDisabled}
                onChange={(e) => {
                  const t = e.target.value;
                  if (t === "") return;
                  onSetDefault(m, t as LlmTaskType).catch(() => undefined);
                  e.target.value = "";
                }}
                aria-label={`${m.modelName} default-for`}
                className="px-2 py-1 text-sm rounded border border-[var(--color-border)] bg-[var(--color-bg-subtle)] disabled:opacity-50"
              >
                {TASK_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>

      <PullDialog open={pullOpen} onClose={() => setPullOpen(false)} />
    </section>
  );
}
