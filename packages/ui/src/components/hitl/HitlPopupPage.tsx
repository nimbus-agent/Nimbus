import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createIpcClient } from "../../ipc/client";
import { useNimbusStore } from "../../store";
import { isConnectorWriteDetails } from "./ConnectorWritePreview";
import { StructuredPreview } from "./StructuredPreview";

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\.delete$/,
  /\.destroy$/,
  /\.cancel$/,
  /\.stop$/,
  /\.rollback$/,
  /\.wipe$/,
  /\.purge$/,
  /\.format$/,
  /\.terminate$/,
  /\.drop$/,
  /\.prune$/,
  /^pipeline\./,
  /^k8s\./,
  /^kubernetes\./,
];

function isDestructive(action: string | undefined): boolean {
  if (!action) return false;
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(action));
}

/**
 * Not destructive, but changes how the whole install behaves: focus starts on Reject so Enter
 * never approves a role pack the owner has not read.
 */
const FOCUS_REJECT: ReadonlySet<string> = new Set(["pack.install"]);

export function HitlPopupPage(): ReactNode {
  const pending = useNimbusStore((s) => s.pending);
  const resolve = useNimbusStore((s) => s.resolve);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const head = pending[0];
  const more = pending.length > 1 ? pending.length - 1 : 0;
  const approveRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  // The type is the gateway's own `actionType` on `consent.request`, and nothing else: not a key of
  // the payload (the payload is the action's data) and not the prompt text (it embeds that data).
  const action = head?.actionType;
  const isMigrate = action === "extension.migrate";
  // The gateway renders a role pack's prompt itself — the pack's exact defaults text — and it is
  // multi-line, so it is shown verbatim in a bounded scroll box rather than as a heading.
  const isPackInstall = action === "pack.install";
  // A preview the gateway built for this very action: the heading is fixed, the body shows the write.
  const isConnectorWrite = isConnectorWriteDetails(head?.details, action);
  // A Wave 4 write: the owner approves only by typing this text exactly (no trim, no case fold).
  // The gateway judges the answer; this page only withholds the button until it matches.
  const confirmText =
    head?.confirmText !== undefined && head.confirmText !== "" ? head.confirmText : undefined;
  const typedMatches = confirmText === undefined || typed === confirmText;

  // Focus is placed imperatively, keyed on the action, NOT via the `autoFocus` attribute. React
  // honours `autoFocus` only at mount, and this popup does not remount between queued requests —
  // it re-renders with `pending[0]` replaced. So `autoFocus={!isDestructive(action)}` applied the
  // deny-list to the FIRST request only: a safe request followed by a destructive one left focus
  // sitting on Approve, which is exactly the keystroke the deny-list exists to prevent.
  //
  // A destructive action moves focus to Reject rather than merely declining to focus Approve.
  // Leaving it where it was is the same failure one step removed.
  useEffect(() => {
    if (head === undefined) return;
    // A confirm field takes focus whatever the action type: the owner must read and type, and
    // Enter never approves (the Approve button is not reachable by a stray keystroke).
    if (head.confirmText !== undefined && head.confirmText !== "") {
      confirmRef.current?.focus();
      return;
    }
    // No `actionType` (an older installed gateway) means the type is unknown, and an unknown type
    // is not assumed safe: focus fails closed to Reject.
    const target =
      action === undefined || isDestructive(action) || FOCUS_REJECT.has(action)
        ? rejectRef.current
        : approveRef.current;
    target?.focus();
  }, [action, head]);

  // A queued request replaces `pending[0]` without remounting: never carry typed text across.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the request id only
  useEffect(() => {
    setTyped("");
  }, [head?.requestId]);

  useEffect(() => {
    if (pending.length === 0) {
      const id = setTimeout(() => {
        invoke("close_hitl_popup").catch(() => undefined);
      }, 500);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [pending.length]);

  async function decide(approved: boolean): Promise<void> {
    if (!head) return;
    setBusy(true);
    setError(null);
    try {
      if (confirmText === undefined) {
        await createIpcClient().consentRespond(head.requestId, approved);
      } else {
        await createIpcClient().consentRespond(head.requestId, approved, approved ? typed : "");
      }
      resolve(head.requestId, approved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!head) {
    return <div className="p-5 text-[var(--color-fg-muted)] text-sm">No pending requests.</div>;
  }

  return (
    <div className="p-5 space-y-4">
      <header>
        <h2 className="text-base font-medium text-[var(--color-fg)]">
          {packHeading(isMigrate, isPackInstall, isConnectorWrite, head.prompt)}
        </h2>
      </header>
      {isPackInstall ? (
        <pre
          data-testid="pack-install-prompt"
          className="whitespace-pre-wrap break-words font-mono text-xs border border-[var(--color-border)] rounded p-2"
          style={{ maxHeight: 200, overflow: "auto" }}
        >
          {head.prompt}
        </pre>
      ) : (
        <StructuredPreview details={head.details} {...(action === undefined ? {} : { action })} />
      )}
      {confirmText !== undefined && (
        <div className="space-y-1">
          <p className="text-xs text-[var(--color-fg-muted)]">
            To approve, type exactly (case matters, no extra spaces):
          </p>
          <code
            data-testid="confirm-text"
            className="block font-mono text-xs border border-[var(--color-border)] rounded p-2 break-all"
          >
            {confirmText}
          </code>
          <label className="block text-xs text-[var(--color-fg)]" htmlFor="confirm-text-input">
            Type the text above to enable Approve
          </label>
          <input
            id="confirm-text-input"
            ref={confirmRef}
            type="text"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              // Enter never approves a confirm prompt.
              if (e.key === "Enter") e.preventDefault();
            }}
            className="w-full font-mono text-xs border border-[var(--color-border)] rounded p-2 bg-transparent"
          />
        </div>
      )}
      {error && (
        <div className="text-[var(--color-error)] text-xs" role="alert">
          {error}
        </div>
      )}
      <footer className="flex justify-end gap-2">
        <button
          ref={rejectRef}
          type="button"
          className="px-3 py-1 border border-[var(--color-border)] rounded text-[var(--color-fg-muted)]"
          disabled={busy}
          onClick={() => decide(false)}
        >
          Reject
        </button>
        <button
          ref={approveRef}
          type="button"
          className="px-3 py-1 bg-[var(--color-accent)] text-white rounded"
          disabled={busy || !typedMatches}
          onClick={() => decide(true)}
        >
          Approve
        </button>
      </footer>
      {more > 0 && <p className="text-xs text-[var(--color-fg-muted)]">+{more} more pending</p>}
    </div>
  );
}

function packHeading(
  isMigrate: boolean,
  isPackInstall: boolean,
  isConnectorWrite: boolean,
  prompt: string,
): string {
  if (isMigrate) return "Keep this connector as a signed extension?";
  if (isPackInstall) return "Install this role pack?";
  if (isConnectorWrite) return "Approve this connector write?";
  return prompt;
}
