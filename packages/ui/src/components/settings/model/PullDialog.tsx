import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createIpcClient } from "../../../ipc/client";
import type {
  JsonRpcNotification,
  LlmPullProgressPayload,
  LlmPullTerminalPayload,
} from "../../../ipc/types";
import { useNimbusStore } from "../../../store";

const STALL_MS = 15_000;

function pullStatusText(
  pullStalled: boolean,
  activeRow: LlmPullProgressPayload | undefined,
  percent: number,
): ReactNode {
  if (pullStalled) return <span className="text-amber-500">Connecting…</span>;
  if (activeRow !== undefined)
    return (
      <span>
        {activeRow.status} · {percent}%
      </span>
    );
  return null;
}

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function PullDialog({ open, onClose }: Props) {
  const activePullId = useNimbusStore((s) => s.activePullId);
  const pullProgress = useNimbusStore((s) => s.pullProgress);
  const pullStalled = useNimbusStore((s) => s.pullStalled);
  const setActivePullId = useNimbusStore((s) => s.setActivePullId);
  const upsertPullProgress = useNimbusStore((s) => s.upsertPullProgress);
  const clearPullProgress = useNimbusStore((s) => s.clearPullProgress);
  const setPullStalled = useNimbusStore((s) => s.setPullStalled);

  const [provider, setProvider] = useState<"ollama" | "llamacpp">("ollama");
  const [modelName, setModelName] = useState("");
  const [available, setAvailable] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const { available: a } = await createIpcClient().llmGetStatus();
        setAvailable(a);
        if (a.ollama === false && a.llamacpp === true) setProvider("llamacpp");
      } catch {
        setAvailable({ ollama: true, llamacpp: true });
      }
    })();
  }, [open]);

  const onNotification = useCallback(
    (n: JsonRpcNotification) => {
      if (n.method === "llm.pullProgress") {
        const p = n.params as LlmPullProgressPayload;
        upsertPullProgress(p);
        setPullStalled(false);
        if (stallTimerRef.current !== null) clearTimeout(stallTimerRef.current);
        stallTimerRef.current = setTimeout(() => setPullStalled(true), STALL_MS);
        return;
      }
      if (n.method === "llm.pullCompleted") {
        const p = n.params as LlmPullTerminalPayload;
        clearPullProgress(p.pullId);
        setActivePullId(null);
        setPullStalled(false);
        if (stallTimerRef.current !== null) clearTimeout(stallTimerRef.current);
        return;
      }
      if (n.method === "llm.pullFailed") {
        const p = n.params as LlmPullTerminalPayload;
        clearPullProgress(p.pullId);
        setActivePullId(null);
        setPullStalled(false);
        if (stallTimerRef.current !== null) clearTimeout(stallTimerRef.current);
        setError(p.error ?? "Pull failed");
      }
    },
    [clearPullProgress, setActivePullId, setPullStalled, upsertPullProgress],
  );

  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    createIpcClient()
      .subscribe(onNotification)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    if (activePullId !== null) {
      if (stallTimerRef.current !== null) clearTimeout(stallTimerRef.current);
      stallTimerRef.current = setTimeout(() => setPullStalled(true), STALL_MS);
    }
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (stallTimerRef.current !== null) clearTimeout(stallTimerRef.current);
    };
  }, [open, onNotification, activePullId, setPullStalled]);

  const onSubmit = useCallback(async () => {
    if (modelName.trim() === "") return;
    setSubmitting(true);
    setError(null);
    try {
      const { pullId } = await createIpcClient().llmPullModel(provider, modelName.trim());
      setActivePullId(pullId);
      if (stallTimerRef.current !== null) clearTimeout(stallTimerRef.current);
      stallTimerRef.current = setTimeout(() => setPullStalled(true), STALL_MS);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [modelName, provider, setActivePullId, setPullStalled]);

  const onCancel = useCallback(async () => {
    if (activePullId === null) return;
    await createIpcClient().llmCancelPull(activePullId);
  }, [activePullId]);

  if (!open) return null;

  const activeRow = activePullId === null ? undefined : pullProgress[activePullId];
  const percent =
    activeRow?.completedBytes !== undefined &&
    activeRow.totalBytes !== undefined &&
    activeRow.totalBytes > 0
      ? Math.min(100, Math.round((activeRow.completedBytes / activeRow.totalBytes) * 100))
      : 0;

  return (
    <dialog
      open
      aria-modal="true"
      aria-label="Pull model"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="bg-[var(--color-bg)] rounded-md p-6 w-[480px] border border-[var(--color-border)]">
        <h3 className="text-lg font-semibold mb-4">Pull a model</h3>

        <fieldset className="mb-4">
          <legend className="text-sm mb-2">Provider</legend>
          {available.ollama === true && (
            <label className="mr-4 text-sm">
              <input
                type="radio"
                name="provider"
                value="ollama"
                checked={provider === "ollama"}
                onChange={() => setProvider("ollama")}
                aria-label="Ollama"
              />{" "}
              Ollama
            </label>
          )}
          {available.llamacpp === true && (
            <label className="text-sm">
              <input
                type="radio"
                name="provider"
                value="llamacpp"
                checked={provider === "llamacpp"}
                onChange={() => setProvider("llamacpp")}
                aria-label="llama.cpp"
              />{" "}
              llama.cpp
            </label>
          )}
        </fieldset>

        <label className="block mb-4 text-sm">
          <span className="block mb-1">Model name</span>
          <input
            type="text"
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            placeholder="gemma:2b"
            aria-label="Model name"
            className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-subtle)]"
          />
        </label>

        {(activeRow !== undefined || activePullId !== null) && (
          <div className="mb-4">
            <div className="w-full h-2 rounded-full bg-[var(--color-border)] overflow-hidden">
              <progress
                value={percent}
                max={100}
                aria-valuenow={percent}
                className="h-full bg-[var(--color-accent)]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-[var(--color-text-muted)]">
              {pullStatusText(pullStalled, activeRow, percent)}
            </div>
          </div>
        )}

        {error !== null && <p className="text-sm text-[var(--color-danger-text)] mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 rounded border border-[var(--color-border)]"
          >
            Close
          </button>
          {activePullId === null ? (
            <button
              type="button"
              onClick={onSubmit}
              disabled={submitting || modelName.trim() === ""}
              aria-label="Pull"
              className="px-3 py-1 rounded bg-[var(--color-accent)] text-white disabled:opacity-50"
            >
              Pull
            </button>
          ) : (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Cancel pull"
              className="px-3 py-1 rounded border border-[var(--color-danger-border)] text-[var(--color-danger-text)]"
            >
              Cancel pull
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
