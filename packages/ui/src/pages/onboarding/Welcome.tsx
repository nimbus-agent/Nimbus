import type React from "react";
import { useNavigate } from "react-router";
import { createIpcClient } from "../../ipc/client";

export function Welcome() {
  const navigate = useNavigate();

  const onSkip = async () => {
    await createIpcClient().call("db.setMeta", {
      key: "onboarding_completed",
      value: new Date().toISOString(),
    });
    navigate("/", { replace: true });
  };

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
        Step 1
      </div>
      <h2 style={{ marginTop: 0 }}>Welcome to Nimbus</h2>
      <p>
        Nimbus indexes your work — code, docs, chats, tickets — on <strong>your machine</strong>.
        Nothing leaves unless you explicitly allow it.
      </p>
      <ul style={{ lineHeight: 1.8, color: "var(--color-fg)" }}>
        <li>Local-first — your index lives on this computer</li>
        <li>Every action is logged and auditable</li>
        <li>You approve every write before it happens (HITL)</li>
      </ul>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
        <button type="button" onClick={onSkip} style={btn("ghost")}>
          Skip setup
        </button>
        <button
          type="button"
          onClick={() => navigate("/onboarding/connect")}
          style={btn("primary")}
        >
          Continue →
        </button>
      </div>
    </div>
  );
}

function btn(variant: "primary" | "ghost"): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "8px 20px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    cursor: "pointer",
  };
  if (variant === "primary")
    return {
      ...base,
      background: "var(--color-accent)",
      color: "white",
      border: "1px solid var(--color-accent)",
    };
  return {
    ...base,
    background: "transparent",
    color: "var(--color-fg-muted)",
    border: "1px solid transparent",
  };
}
