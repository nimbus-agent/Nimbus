import { useCallback, useState } from "react";
import { useIpcSubscription } from "../hooks/useIpcSubscription";

export function HotkeyFailedBanner() {
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Subscribed through the shared hook, like every other Tauri event in the app, rather than a
  // hand-rolled `listen`: the inline version left `listen`'s promise floating, and leaked the
  // listener when the component unmounted before that promise resolved (its cleanup ran while
  // `stop` was still null). The hook unlistens a late-resolving subscription on its own.
  const onHotkeyFailed = useCallback((payload: unknown) => {
    setError(typeof payload === "string" ? payload : "Unknown error");
  }, []);
  useIpcSubscription<unknown>("tray://hotkey-failed", onHotkeyFailed);

  if (!error || dismissed) return null;
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "8px 16px",
        background: "rgba(212, 166, 87, 0.12)",
        borderBottom: "1px solid var(--color-amber)",
        color: "var(--color-fg)",
        fontSize: 12,
      }}
    >
      <span>
        Quick-query hotkey (<strong>Ctrl+Shift+N</strong>) could not be registered — it may be bound
        by another app. Details: {error}
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        style={{
          padding: "4px 10px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--color-border)",
          background: "transparent",
          color: "var(--color-fg-muted)",
          cursor: "pointer",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
