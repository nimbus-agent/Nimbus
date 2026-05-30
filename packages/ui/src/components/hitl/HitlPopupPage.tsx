import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useState } from "react";
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

  const action =
    head.details && typeof head.details["action"] === "string"
      ? head.details["action"]
      : ((head as unknown as { action?: string }).action ?? undefined);

  return (
    <div className="p-5 space-y-4">
      <header>
        <h2 className="text-base font-medium text-[var(--color-fg)]">{head.prompt}</h2>
      </header>
      <StructuredPreview details={head.details} {...(action !== undefined ? { action } : {})} />
      {error && (
        <div className="text-[var(--color-error)] text-xs" role="alert">
          {error}
        </div>
      )}
      <footer className="flex justify-end gap-2">
        <button
          type="button"
          className="px-3 py-1 border border-[var(--color-border)] rounded text-[var(--color-fg-muted)]"
          disabled={busy}
          onClick={() => decide(false)}
        >
          Reject
        </button>
        <button
          type="button"
          className="px-3 py-1 bg-[var(--color-accent)] text-white rounded"
          // biome-ignore lint/a11y/noAutofocus: deliberate UX; deny-list gates it for destructive actions
          autoFocus={!isDestructive(action)}
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
