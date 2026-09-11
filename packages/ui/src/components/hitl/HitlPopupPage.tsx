import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createIpcClient } from "../../ipc/client";
import { useNimbusStore } from "../../store";
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

export function HitlPopupPage(): ReactNode {
  const pending = useNimbusStore((s) => s.pending);
  const resolve = useNimbusStore((s) => s.resolve);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const head = pending[0];
  const more = pending.length > 1 ? pending.length - 1 : 0;
  const approveRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);

  const action =
    head?.details && typeof head.details["action"] === "string"
      ? head.details["action"]
      : ((head as unknown as { action?: string } | undefined)?.action ?? undefined);

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
    const target = isDestructive(action) ? rejectRef.current : approveRef.current;
    target?.focus();
  }, [action, head]);

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
      await createIpcClient().consentRespond(head.requestId, approved);
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
        <h2 className="text-base font-medium text-[var(--color-fg)]">{head.prompt}</h2>
      </header>
      <StructuredPreview details={head.details} {...(action === undefined ? {} : { action })} />
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
          disabled={busy}
          onClick={() => decide(true)}
        >
          Approve
        </button>
      </footer>
      {more > 0 && <p className="text-xs text-[var(--color-fg-muted)]">+{more} more pending</p>}
    </div>
  );
}
