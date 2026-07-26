import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { createIpcClient } from "../../ipc/client";
import type { DiagSnapshot } from "../../ipc/types";

export function Syncing() {
  const navigate = useNavigate();
  const [snap, setSnap] = useState<DiagSnapshot | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(Date.now());
  const autoCompleted = useRef(false);

  useEffect(() => {
    const client = createIpcClient();
    const tick = async () => {
      try {
        const s = await client.call<DiagSnapshot>("diag.snapshot");
        setSnap(s);
        setLastUpdate(Date.now());
      } catch {
        /* leave counters stale until reconnect */
      }
    };
    void tick();
    const iv = setInterval(tick, 5000);

    const autoComplete = async () => {
      if (autoCompleted.current) return;
      autoCompleted.current = true;
      try {
        await client.call("db.setMeta", {
          key: "onboarding_completed",
          value: new Date().toISOString(),
        });
      } catch {
        /* swallow */
      }
    };

    const onVis = () => {
      if (document.visibilityState === "hidden") void autoComplete();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
      void autoComplete();
    };
  }, []);

  const onOpenDashboard = async () => {
    autoCompleted.current = true;
    await createIpcClient().call("db.setMeta", {
      key: "onboarding_completed",
      value: new Date().toISOString(),
    });
    navigate("/", { replace: true });
  };

  const ageSeconds = Math.floor((Date.now() - lastUpdate) / 1000);

  return (
    <div>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          color: "var(--color-fg-muted)",
          marginBottom: 6,
        }}
      >
        Step 3
      </div>
      <h2 style={{ marginTop: 0 }}>You're set up</h2>
      <p style={{ color: "var(--color-fg-muted)" }}>
        Nimbus is indexing your data. You can close this window — it'll keep syncing in the
        background.
      </p>
      <div
        style={{
          marginTop: 22,
          padding: "16px 20px",
          border: "1px solid var(--color-ok)",
          borderRadius: "var(--radius-md)",
          background: "rgba(82, 196, 26, 0.08)",
        }}
      >
        <div style={{ display: "flex", gap: 24, fontSize: 13 }}>
          <span>
            <strong>{snap?.indexTotalItems ?? 0}</strong> items indexed
          </span>
          <span>
            <strong>{snap?.connectorCount ?? 0}</strong> connectors syncing
          </span>
          <span>
            Updated <strong>{ageSeconds}s ago</strong>
          </span>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 32 }}>
        <button
          type="button"
          onClick={onOpenDashboard}
          style={{
            padding: "8px 20px",
            borderRadius: "var(--radius-md)",
            background: "var(--color-accent)",
            color: "white",
            border: "1px solid var(--color-accent)",
            cursor: "pointer",
          }}
        >
          Open Dashboard →
        </button>
      </div>
    </div>
  );
}
