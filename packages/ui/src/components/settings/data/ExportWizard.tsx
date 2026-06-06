import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { exists } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import zxcvbn from "zxcvbn";
import { useIpcSubscription } from "../../../hooks/useIpcSubscription";
import { createIpcClient } from "../../../ipc/client";
import type {
  DataExportProgressPayload,
  DataExportResult,
  JsonRpcNotification,
} from "../../../ipc/types";
import { useNimbusStore } from "../../../store";

type Step =
  | "scope"
  | "passphrase"
  | "destination"
  | "overwrite-confirm"
  | "exporting"
  | "seed-first-time"
  | "seed-reminder"
  | "done"
  | "error";

interface ExportWizardProps {
  readonly onClose: () => void;
}

function todayYyyyMmDd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function ExportWizard({ onClose }: ExportWizardProps) {
  const [step, setStep] = useState<Step>("scope");
  const [includeIndex, setIncludeIndex] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [destPath, setDestPath] = useState<string | null>(null);
  const [overwriteTarget, setOverwriteTarget] = useState<string | null>(null);
  const [result, setResult] = useState<DataExportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [seedChecked, setSeedChecked] = useState(false);
  const [countdownMs, setCountdownMs] = useState<number | null>(null);

  const setExportFlow = useNimbusStore((s) => s.setExportFlow);
  const setExportProgress = useNimbusStore((s) => s.setExportProgress);
  const progress = useNimbusStore((s) => s.exportFlow.progress);

  const copyTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipboardActiveRef = useRef(false);

  const cancelCountdown = useCallback(() => {
    if (copyTimerRef.current !== null) {
      clearInterval(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    clipboardActiveRef.current = false;
    setCountdownMs(null);
  }, []);

  useEffect(() => {
    return () => {
      setPassphrase("");
      setConfirmPassphrase("");
      if (clipboardActiveRef.current) {
        Promise.resolve(writeText("")).catch(() => undefined);
      }
      cancelCountdown();
    };
  }, [cancelCountdown]);

  const onNotification = useCallback(
    (n: JsonRpcNotification) => {
      if (n.method === "data.exportProgress") {
        setExportProgress(n.params as DataExportProgressPayload); // NOSONAR S4325: n.params is unknown; narrowed to the typed notification payload
      }
    },
    [setExportProgress],
  );
  useIpcSubscription<JsonRpcNotification>("gateway://notification", onNotification);

  const zxcvbnScore = useMemo(
    () => (passphrase.length === 0 ? 0 : zxcvbn(passphrase).score),
    [passphrase],
  );
  const passphraseValid =
    passphrase.length >= 12 && passphrase === confirmPassphrase && zxcvbnScore >= 3;

  const runExport = useCallback(
    async (output: string) => {
      setStep("exporting");
      setExportFlow({ status: "running" });
      try {
        const res = await createIpcClient().dataExport({
          output,
          passphrase,
          includeIndex,
        });
        setResult(res);
        setExportFlow({ status: "idle" });
        setStep(res.recoverySeedGenerated ? "seed-first-time" : "seed-reminder");
      } catch (err) {
        setErrorMessage((err as Error).message);
        setExportFlow({
          status: "error",
          errorKind: "rpc_failed",
          errorMessage: (err as Error).message,
        });
        setStep("error");
      }
    },
    [passphrase, includeIndex, setExportFlow],
  );

  const runExportRef = useRef(runExport);
  useEffect(() => {
    runExportRef.current = runExport;
  }, [runExport]);

  const onPickDestination = useCallback(async () => {
    const defaultPath = `nimbus-backup-${todayYyyyMmDd()}.tar.gz`;
    const picked = await saveDialog({
      defaultPath,
      filters: [{ name: "Nimbus backup", extensions: ["tar.gz"] }],
    });
    if (picked === null) return;
    const conflict = await exists(picked);
    if (conflict) {
      setOverwriteTarget(picked);
      setStep("overwrite-confirm");
    } else {
      setDestPath(picked);
      runExportRef.current(picked).catch(() => undefined);
    }
  }, []);

  const onOverwriteConfirm = useCallback(() => {
    if (overwriteTarget === null) return;
    setDestPath(overwriteTarget);
    runExportRef.current(overwriteTarget).catch(() => undefined);
  }, [overwriteTarget]);

  const onCopySeed = useCallback(async () => {
    if (result === null) return;
    await writeText(result.recoverySeed);
    cancelCountdown();
    clipboardActiveRef.current = true;
    setCountdownMs(30_000);
    copyTimerRef.current = setInterval(() => {
      setCountdownMs((ms) => (ms === null ? null : Math.max(0, ms - 1000)));
    }, 1000);
    clearTimerRef.current = setTimeout(() => {
      Promise.resolve(writeText("")).catch(() => undefined);
      cancelCountdown();
    }, 30_000);
  }, [result, cancelCountdown]);

  const progressPct =
    progress?.totalBytes !== undefined && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesWritten / progress.totalBytes) * 100))
      : null;

  return (
    <dialog
      open
      aria-modal="true"
      data-testid="export-wizard"
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 border-0 max-w-none w-full h-full m-0"
    >
      <div className="bg-[var(--color-bg)] rounded-lg max-w-lg w-full p-6 space-y-4 border border-[var(--color-border)]">
        {step === "scope" && (
          <>
            <h2 className="text-xl font-semibold">Backup scope</h2>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeIndex}
                onChange={(e) => setIncludeIndex(e.target.checked)}
              />{" "}
              Include search index (.db)
            </label>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => setStep("passphrase")}
                className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white"
              >
                Next
              </button>
            </div>
          </>
        )}

        {step === "passphrase" && (
          <>
            <h2 className="text-xl font-semibold">Choose a passphrase</h2>
            <p className="text-sm text-[var(--color-text-muted)]">
              Encrypts the vault inside your backup. Minimum 12 characters. Strength must be Fair or
              higher.
            </p>
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="w-full px-2 py-1 border border-[var(--color-border)] rounded"
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Confirm passphrase"
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
              className="w-full px-2 py-1 border border-[var(--color-border)] rounded"
            />
            <div data-testid="zxcvbn-score" className="text-xs">
              Strength: {["Very weak", "Weak", "Fair", "Good", "Strong"][zxcvbnScore]}
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setStep("scope")}>
                Back
              </button>
              <button
                type="button"
                disabled={!passphraseValid}
                onClick={() => setStep("destination")}
                className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </>
        )}

        {step === "destination" && (
          <>
            <h2 className="text-xl font-semibold">Choose destination</h2>
            <p className="text-sm">
              A save dialog will open. The file defaults to{" "}
              <code>nimbus-backup-{todayYyyyMmDd()}.tar.gz</code>.
            </p>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setStep("passphrase")}>
                Back
              </button>
              <button
                type="button"
                onClick={onPickDestination}
                className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white"
              >
                Choose file…
              </button>
            </div>
          </>
        )}

        {step === "overwrite-confirm" && overwriteTarget !== null && (
          <>
            <h2 className="text-xl font-semibold">File already exists</h2>
            <p className="text-sm">
              Overwrite <code>{overwriteTarget}</code>?
            </p>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setStep("destination")}>
                Cancel
              </button>
              <button
                type="button"
                onClick={onOverwriteConfirm}
                className="px-3 py-1.5 rounded-md bg-[var(--color-danger)] text-white"
              >
                Overwrite
              </button>
            </div>
          </>
        )}

        {step === "exporting" && (
          <>
            <h2 className="text-xl font-semibold">Creating backup…</h2>
            {progressPct === null ? (
              <progress
                data-testid="export-progress-indeterminate"
                aria-valuetext="indeterminate"
                className="w-full h-2 bg-[var(--color-bg-subtle)] rounded overflow-hidden animate-pulse"
              />
            ) : (
              <progress
                data-testid="export-progress-bar"
                value={progressPct}
                max={100}
                aria-valuenow={progressPct}
                className="w-full h-2 bg-[var(--color-bg-subtle)] rounded overflow-hidden"
              />
            )}
            <p className="text-xs text-[var(--color-text-muted)]">
              Stage: {progress?.stage ?? "starting"}
            </p>
          </>
        )}

        {step === "seed-first-time" && result !== null && (
          <>
            <h2 className="text-xl font-semibold">Save your recovery seed</h2>
            <p className="text-sm font-semibold text-[var(--color-danger)]">
              Nimbus cannot recover this seed for you if you lose it.
            </p>
            <pre
              data-testid="recovery-seed"
              className="p-3 bg-[var(--color-bg-subtle)] rounded text-sm whitespace-pre-wrap"
            >
              {result.recoverySeed}
            </pre>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onCopySeed()}
                className="px-2 py-1 rounded border border-[var(--color-border)] text-sm"
              >
                Copy
              </button>
              {countdownMs !== null && (
                <span data-testid="clipboard-countdown" className="text-xs">
                  Clipboard clears in 0:{String(Math.ceil(countdownMs / 1000)).padStart(2, "0")}
                </span>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={seedChecked}
                onChange={(e) => setSeedChecked(e.target.checked)}
              />{" "}
              I have stored this seed somewhere safe.
            </label>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                disabled={!seedChecked}
                onClick={onClose}
                className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white disabled:opacity-50"
              >
                Done
              </button>
            </div>
          </>
        )}

        {step === "seed-reminder" && (
          <>
            <h2 className="text-xl font-semibold">Backup saved</h2>
            <p className="text-sm">
              Your recovery seed hasn't changed — keep your saved copy somewhere safe.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white"
              >
                Done
              </button>
            </div>
          </>
        )}

        {step === "error" && (
          <>
            <h2 className="text-xl font-semibold">Export failed</h2>
            <p className="text-sm">
              {errorMessage}
              {destPath !== null && (
                <>
                  {" "}
                  A partial file may exist at <code>{destPath}</code> — delete it before retrying.
                </>
              )}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-md border border-[var(--color-border)]"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
