import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { createIpcClient } from "../../ipc/client";
import { useNimbusStore } from "../../store";

/**
 * The subset of the gateway's `SyncStatus` this page reads, named for what it is: the shape on the
 * wire. `healthState` carries the same six-member `ConnectorHealthState` union the UI calls
 * `ConnectorHealth`, and is optional because a connector with no health row yet has none.
 */
interface WireConnectorStatus {
  readonly serviceId: string;
  readonly healthState?: string;
}

const CONNECTORS = ["Google Drive", "GitHub", "Slack", "Linear", "Notion", "Gmail"] as const;

type AuthStatus = "authenticating" | "connected" | "failed" | "cancelled" | "pending";

const STATUS_COLOR: Record<AuthStatus, string> = {
  connected: "var(--color-ok)",
  failed: "var(--color-error)",
  cancelled: "var(--color-error)",
  authenticating: "var(--color-amber)",
  pending: "var(--color-amber)",
};

const STATUS_LABEL: Record<AuthStatus, string> = {
  authenticating: "Authenticating…",
  connected: "Connected",
  failed: "Failed — retry",
  cancelled: "Cancelled — retry",
  pending: "Pending",
};
const CONNECTOR_DESCRIPTIONS: Record<(typeof CONNECTORS)[number], string> = {
  "Google Drive": "Docs, Sheets, Slides",
  GitHub: "Repos, PRs, issues",
  Slack: "Channels, DMs",
  Linear: "Issues, projects",
  Notion: "Pages, databases",
  Gmail: "Mail + labels",
};

export function Connect() {
  const navigate = useNavigate();
  const selected = useNimbusStore((s) => s.selected);
  const authStatus = useNimbusStore((s) => s.authStatus);
  const toggleSelected = useNimbusStore((s) => s.toggleSelected);
  const setAuthStatus = useNimbusStore((s) => s.setAuthStatus);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  const onAuth = async () => {
    const client = createIpcClient();
    const services = [...selected];
    for (const name of services) setAuthStatus(name, "authenticating");
    for (const name of services) {
      try {
        await client.call("connector.startAuth", { service: name });
      } catch {
        setAuthStatus(name, "failed");
      }
    }
    pollRef.current = setInterval(async () => {
      try {
        // `connector.listStatus`, not `connector.list`. The latter sat on the Tauri allowlist with
        // no gateway handler behind it, so this poll returned -32601 on every tick and the bare
        // `catch` below classified a permanent structural error as transient — the navigate was
        // unreachable. `listStatus` is what every other consumer calls.
        //
        // Typed against the WIRE shape (`SyncStatus` in gateway `sync/types.ts`), deliberately not
        // against this package's `ConnectorStatus`, which declares `{ name, health }` and does not
        // match what the gateway sends. That mismatch is real and pre-existing — `ConnectorGrid`
        // and `ConnectorsPanel` read `.name`/`.health` off this same call and get `undefined` —
        // but it is a separate defect in a surface that has never shipped, and inheriting the
        // wrong type here to be consistent with it would just spread the bug.
        const list = await client.call<WireConnectorStatus[]>("connector.listStatus");
        let anyConnected = false;
        for (const name of services) {
          const summary = list.find((c) => c.serviceId === name);
          // Absent healthState means the connector has no health row yet — not yet authenticated.
          if (
            summary &&
            summary.healthState !== undefined &&
            summary.healthState !== "unauthenticated"
          ) {
            setAuthStatus(name, "connected");
            anyConnected = true;
          }
        }
        if (anyConnected) {
          if (pollRef.current) clearInterval(pollRef.current);
          navigate("/onboarding/syncing");
        }
      } catch {
        // transient; keep polling
      }
    }, 2000);
  };

  const selectedCount = selected.size;

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
        Step 2
      </div>
      <h2 style={{ marginTop: 0 }}>Connect your first service</h2>
      <p style={{ color: "var(--color-fg-muted)" }}>
        Pick one or more. You can add others from Settings.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10,
          marginTop: 18,
        }}
      >
        {CONNECTORS.map((name) => {
          const isSelected = selected.has(name);
          const status = authStatus[name];
          return (
            <button
              type="button"
              key={name}
              onClick={() => toggleSelected(name)}
              style={{
                textAlign: "left",
                padding: 14,
                border: `1px solid ${isSelected ? "var(--color-accent)" : "var(--color-border)"}`,
                borderRadius: "var(--radius-md)",
                background: isSelected ? "rgba(120, 144, 255, 0.12)" : "transparent",
                color: "var(--color-fg)",
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 13, marginBottom: 4 }}>
                {isSelected && <span aria-hidden="true">✓ </span>}
                <span>{name}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--color-fg-muted)" }}>
                {CONNECTOR_DESCRIPTIONS[name]}
              </div>
              {status && (
                <div
                  style={{
                    fontSize: 11,
                    marginTop: 6,
                    color: STATUS_COLOR[status] ?? STATUS_COLOR.pending,
                  }}
                >
                  {STATUS_LABEL[status] ?? STATUS_LABEL.pending}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
        <button
          type="button"
          onClick={() => navigate("/onboarding/welcome")}
          style={{
            padding: "8px 20px",
            borderRadius: "var(--radius-md)",
            background: "transparent",
            color: "var(--color-fg)",
            border: "1px solid var(--color-border)",
            cursor: "pointer",
          }}
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onAuth}
          disabled={selectedCount === 0}
          style={{
            padding: "8px 20px",
            borderRadius: "var(--radius-md)",
            background: selectedCount === 0 ? "var(--color-surface)" : "var(--color-accent)",
            color: selectedCount === 0 ? "var(--color-fg-muted)" : "white",
            border: "1px solid var(--color-accent)",
            cursor: selectedCount === 0 ? "not-allowed" : "pointer",
          }}
        >
          Authenticate ({selectedCount}) →
        </button>
      </div>
    </div>
  );
}
