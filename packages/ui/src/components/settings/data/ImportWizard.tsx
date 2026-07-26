import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useIpcSubscription } from "../../../hooks/useIpcSubscription";
import { createIpcClient } from "../../../ipc/client";
import type {
  DataImportProgressPayload,
  DataImportVersionIncompatibleData,
  JsonRpcNotification,
} from "../../../ipc/types";
import { JsonRpcError } from "../../../ipc/types";
import { useNimbusStore } from "../../../store";

type AuthMethod = "passphrase" | "recoverySeed";
type Step =
  | "file"
  | "auth"
  | "confirm"
  | "importing"
  | "done"
  | "error-retryable"
  | "error-terminal";

interface ImportWizardProps {
  readonly onClose: () => void;
}

const TYPED_CONFIRM_PHRASE = "replace my data";
const RELOAD_DELAY_MS = 3000;

function looksLikeBip39Word(v: string): boolean {
  return /^[a-z]{3,8}$/.test(v.trim());
}

type ImportErrorResult =
  | { step: "error-terminal"; copy: string; deepLink: string | null; errorKind: "terminal" }
  | {
      step: "error-retryable";
      copy: string;
      errorKind: "validation" | "rpc_failed";
      errorMessage?: string;
    };

function classifyImportError(err: unknown, authMethod: AuthMethod): ImportErrorResult {
  const rpcErr = err instanceof JsonRpcError ? err : null;
  if (rpcErr?.payload.code === -32010) {
    const data = rpcErr.payload.data as DataImportVersionIncompatibleData | undefined;
    if (data?.relation === "archive_newer") {
      return {
        step: "error-terminal",
        copy: "This backup is from a newer Nimbus. Update Nimbus, then retry.",
        deepLink: "/settings/updates",
        errorKind: "terminal",
      };
    }
    return {
      step: "error-terminal",
      copy: "This backup is from an older, unsupported Nimbus. No migration path in v0.1.0.",
      deepLink: null,
      errorKind: "terminal",
    };
  }
  if (rpcErr?.payload.code === -32003) {
    return {
      step: "error-terminal",
      copy: "Archive is corrupt or tampered. No changes made.",
      deepLink: null,
      errorKind: "terminal",
    };
  }
  if (rpcErr?.payload.code === -32002) {
    const copy =
      authMethod === "passphrase"
        ? "Could not decrypt with that passphrase. Check and retry."
        : "Could not decrypt with that recovery seed. Check each word and retry.";
    return { step: "error-retryable", copy, errorKind: "validation" };
  }
  return {
    step: "error-retryable",
    copy: `Import failed — your data was not changed. ${(err as Error).message}`,
    errorKind: "rpc_failed",
    errorMessage: (err as Error).message,
  };
}

export function ImportWizard({ onClose }: ImportWizardProps) {
  const [step, setStep] = useState<Step>("file");
  const [bundlePath, setBundlePath] = useState<string | null>(null);
  const [authMethod, setAuthMethod] = useState<AuthMethod>("passphrase");
  const [passphrase, setPassphrase] = useState("");
  const [seedWords, setSeedWords] = useState<{ id: string; value: string }[]>(() =>
    new Array(12).fill(null).map(() => ({ id: crypto.randomUUID(), value: "" })),
  );
  const [typedConfirm, setTypedConfirm] = useState("");
  const [errorCopy, setErrorCopy] = useState<string | null>(null);
  const [errorDeepLink, setErrorDeepLink] = useState<string | null>(null);
  const [credentialsRestored, setCredentialsRestored] = useState(0);
  const [oauthEntriesFlagged, setOauthEntriesFlagged] = useState(0);

  const setImportFlow = useNimbusStore((s) => s.setImportFlow);
  const setImportProgress = useNimbusStore((s) => s.setImportProgress);
  const progress = useNimbusStore((s) => s.importFlow.progress);
  const navigate = useNavigate();

  useEffect(() => {
    return () => {
      setPassphrase("");
      setSeedWords(new Array(12).fill(null).map(() => ({ id: crypto.randomUUID(), value: "" })));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onNotification = useCallback(
    (n: JsonRpcNotification) => {
      if (n.method === "data.importProgress") {
        setImportProgress(n.params as DataImportProgressPayload); // NOSONAR S4325: n.params is unknown; narrowed to the typed notification payload
      }
    },
    [setImportProgress],
  );
  useIpcSubscription<JsonRpcNotification>("gateway://notification", onNotification);

  const seedValid = useMemo(() => seedWords.every((w) => looksLikeBip39Word(w.value)), [seedWords]);
  const authValid = authMethod === "passphrase" ? passphrase.length > 0 : seedValid;

  const onPickFile = useCallback(async () => {
    const picked = await openDialog({
      filters: [{ name: "Nimbus backup", extensions: ["tar.gz"] }],
    });
    if (typeof picked === "string") {
      setBundlePath(picked);
      setStep("auth");
    }
  }, []);

  const runImport = useCallback(async () => {
    if (bundlePath === null) return;
    setStep("importing");
    setImportFlow({ status: "running" });
    try {
      const client = createIpcClient();
      const res = await client.dataImport({
        bundlePath,
        ...(authMethod === "passphrase" ? { passphrase } : {}),
        ...(authMethod === "recoverySeed"
          ? { recoverySeed: seedWords.map((w) => w.value).join(" ") }
          : {}),
      });
      setCredentialsRestored(res.credentialsRestored);
      setOauthEntriesFlagged(res.oauthEntriesFlagged);
      setImportFlow({ status: "idle" });
      setStep("done");
      setTimeout(() => {
        globalThis.location.reload();
      }, RELOAD_DELAY_MS);
    } catch (err) {
      const classified = classifyImportError(err, authMethod);
      setErrorCopy(classified.copy);
      if (classified.step === "error-terminal") {
        setErrorDeepLink(classified.deepLink);
        setImportFlow({ status: "error", errorKind: "terminal" });
        setStep("error-terminal");
      } else {
        if (classified.errorKind === "rpc_failed") {
          setImportFlow({
            status: "error",
            errorKind: "rpc_failed",
            errorMessage: classified.errorMessage ?? null,
          });
        } else {
          setImportFlow({ status: "error", errorKind: "validation" });
        }
        setStep("error-retryable");
      }
    }
  }, [bundlePath, authMethod, passphrase, seedWords, setImportFlow]);

  const progressPct =
    progress?.totalBytes !== undefined && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesRead / progress.totalBytes) * 100))
      : null;

  return (
    <dialog
      open
      aria-modal="true"
      data-testid="import-wizard"
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 border-0 max-w-none w-full h-full m-0"
    >
      <div className="bg-[var(--color-bg)] rounded-lg max-w-lg w-full p-6 space-y-4 border border-[var(--color-border)]">
        {step === "file" && (
          <>
            <h2 className="text-xl font-semibold">Pick a backup file</h2>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                onClick={onPickFile}
                className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white"
              >
                Choose file…
              </button>
            </div>
          </>
        )}

        {step === "auth" && bundlePath !== null && (
          <>
            <h2 className="text-xl font-semibold">Unlock the backup</h2>
            <p className="text-xs text-[var(--color-text-muted)]">
              File: <code>{bundlePath}</code>
            </p>
            <fieldset className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="auth-method"
                  checked={authMethod === "passphrase"}
                  onChange={() => setAuthMethod("passphrase")}
                />{" "}
                Passphrase
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="auth-method"
                  checked={authMethod === "recoverySeed"}
                  onChange={() => setAuthMethod("recoverySeed")}
                />{" "}
                Recovery seed (12 words)
              </label>
            </fieldset>
            {authMethod === "passphrase" ? (
              <input
                type="password"
                autoComplete="current-password"
                placeholder="Passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="w-full px-2 py-1 border border-[var(--color-border)] rounded"
              />
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2" data-testid="bip39-grid">
                  {seedWords.map((w, i) => (
                    <input
                      key={w.id}
                      type="text"
                      aria-label={`Word ${i + 1}`}
                      value={w.value}
                      onChange={(e) => {
                        const next = [...seedWords];
                        next[i] = { ...w, value: e.target.value.toLowerCase() };
                        setSeedWords(next);
                      }}
                      className={[
                        "px-2 py-1 border rounded text-sm",
                        w.value.length === 0 || looksLikeBip39Word(w.value)
                          ? "border-[var(--color-border)]"
                          : "border-[var(--color-danger)]",
                      ].join(" ")}
                    />
                  ))}
                </div>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Full word validation happens during import — an invalid word surfaces as a
                  decryption error you can retry.
                </p>
              </>
            )}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setStep("file")}>
                Back
              </button>
              <button
                type="button"
                disabled={!authValid}
                onClick={() => setStep("confirm")}
                className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </>
        )}

        {step === "confirm" && (
          <>
            <h2 className="text-xl font-semibold">This replaces your current data</h2>
            <p className="text-sm">
              Importing this backup will overwrite your current index and vault. This cannot be
              undone. Type <code>{TYPED_CONFIRM_PHRASE}</code> to proceed.
            </p>
            <input
              type="text"
              value={typedConfirm}
              onChange={(e) => setTypedConfirm(e.target.value)}
              placeholder={TYPED_CONFIRM_PHRASE}
              className="w-full px-2 py-1 border border-[var(--color-border)] rounded"
            />
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setStep("auth")}>
                Back
              </button>
              <button
                type="button"
                disabled={typedConfirm !== TYPED_CONFIRM_PHRASE}
                onClick={() => runImport()}
                className="px-3 py-1.5 rounded-md bg-[var(--color-danger)] text-white disabled:opacity-50"
              >
                Replace my data
              </button>
            </div>
          </>
        )}

        {step === "importing" && (
          <>
            <h2 className="text-xl font-semibold">Restoring backup…</h2>
            {progressPct === null ? (
              <progress
                data-testid="import-progress-indeterminate"
                aria-valuetext="indeterminate"
                className="w-full h-2 bg-[var(--color-bg-subtle)] rounded overflow-hidden animate-pulse"
              />
            ) : (
              <progress
                data-testid="import-progress-bar"
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

        {step === "done" && (
          <>
            <h2 className="text-xl font-semibold">Restore complete</h2>
            <p className="text-sm">
              Restored {credentialsRestored} credential{credentialsRestored === 1 ? "" : "s"}.
            </p>
            {oauthEntriesFlagged > 0 && (
              <p className="text-sm text-[var(--color-warn-fg)]">
                {oauthEntriesFlagged} OAuth connector{oauthEntriesFlagged === 1 ? "" : "s"} need
                re-authorization.
              </p>
            )}
            <p className="text-sm text-[var(--color-text-muted)]">Reloading in 3 seconds…</p>
          </>
        )}

        {step === "error-retryable" && (
          <>
            <h2 className="text-xl font-semibold">Restore failed</h2>
            <p className="text-sm">{errorCopy}</p>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                onClick={() => setStep("auth")}
                className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white"
              >
                Retry
              </button>
            </div>
          </>
        )}

        {step === "error-terminal" && (
          <>
            <h2 className="text-xl font-semibold">Restore failed</h2>
            <p className="text-sm">{errorCopy}</p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-md border border-[var(--color-border)]"
              >
                Close
              </button>
              {errorDeepLink !== null && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    navigate(errorDeepLink);
                  }}
                  className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white"
                >
                  Go to Updates
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
