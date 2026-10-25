import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { AtlassianForm } from "../../components/onboarding/AtlassianForm";
import { createIpcClient } from "../../ipc/client";
import {
  connectedIds,
  type Suggestion,
  suggestionsFrom,
} from "../../onboarding/connect-suggestions";
import { useNimbusStore } from "../../store";
import type { AuthStatus } from "../../store/slices/onboarding";
import { buttonStyle, cardStyle, plainError, StepLabel } from "./onboarding-ui";

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

const POLL_MS = 2000;

/**
 * The connectors the gateway suggests (the chosen pack's, or the neutral default), each signed in
 * its own way: the browser for OAuth connectors, an inline form for Jira/Confluence, a terminal
 * command for the rest. Connection state is polled from `connector.listStatus`. Nothing navigates
 * on its own — the owner may still be signing in a second connector.
 */
export function Connect(): ReactNode {
  const navigate = useNavigate();
  const selected = useNimbusStore((s) => s.selected);
  const authStatus = useNimbusStore((s) => s.authStatus);
  const toggleSelected = useNimbusStore((s) => s.toggleSelected);
  const setAuthStatus = useNimbusStore((s) => s.setAuthStatus);
  const chosenPackId = useNimbusStore((s) => s.chosenPackId);
  const toDecisions = useNimbusStore((s) => s.endsOnDecisions);
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>([]);
  const [connected, setConnected] = useState<ReadonlySet<string>>(new Set());
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (document.visibilityState === "hidden") return;
    try {
      setConnected(connectedIds(await createIpcClient().call<unknown>("connector.listStatus", {})));
    } catch {
      // transient; the next poll tries again
    }
  }, []);

  useEffect(() => {
    let live = true;
    const client = createIpcClient();
    void client
      .call<unknown>("catalog.list", {})
      .catch(() => null)
      .then((catalog) => {
        if (live) setSuggestions(suggestionsFrom(catalog));
      });
    void refreshStatus();
    const iv = setInterval(() => void refreshStatus(), POLL_MS);
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [refreshStatus]);

  const browserSelected = suggestions.filter(
    (s) => s.signIn === "browser" && selected.has(s.id) && !connected.has(s.id),
  );

  const signInSelected = async (): Promise<void> => {
    if (signingIn) return;
    setSigningIn(true);
    setError(null);
    const client = createIpcClient();
    for (const s of browserSelected) setAuthStatus(s.id, "authenticating");
    for (const s of browserSelected) {
      try {
        await client.call("connector.auth", { service: s.id }); // NOSONAR S9382: each connector.auth runs an interactive sign-in (OAuth opens a browser consent page + loopback callback) - one provider prompt at a time
        setAuthStatus(s.id, "connected");
      } catch (e) {
        setAuthStatus(s.id, "failed");
        setError(`${s.displayName}: ${plainError(e)}`);
      }
    }
    setSigningIn(false);
    await refreshStatus();
  };

  const anyConnected = suggestions.some((s) => connected.has(s.id));
  const next = (): void => {
    void navigate(toDecisions ? "/onboarding/decisions" : "/onboarding/syncing");
  };

  return (
    <div>
      <StepLabel>Connect</StepLabel>
      <h2 style={{ marginTop: 0 }}>Connect your tools</h2>
      <p style={{ color: "var(--color-fg-muted)" }}>
        Pick the ones you use. You can add others from Settings.
      </p>
      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 18 }}
      >
        {suggestions.map((s) => (
          <Tile
            key={s.id}
            s={s}
            isConnected={connected.has(s.id)}
            isSelected={selected.has(s.id)}
            status={authStatus[s.id]}
            onToggle={() => toggleSelected(s.id)}
            onConnected={() => void refreshStatus()}
          />
        ))}
      </div>
      {error !== null && (
        <p role="alert" style={{ color: "var(--color-error)", fontSize: 12 }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32, gap: 8 }}>
        <button
          type="button"
          onClick={() => navigate(chosenPackId === null ? "/onboarding/role" : "/onboarding/pack")}
          style={buttonStyle("outline")}
        >
          ← Back
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={next} style={buttonStyle("ghost")}>
            Skip for now
          </button>
          {browserSelected.length > 0 && (
            <button
              type="button"
              disabled={signingIn}
              onClick={() => void signInSelected()}
              style={buttonStyle("outline", signingIn)}
            >
              {signingIn ? "Signing in…" : `Sign in (${String(browserSelected.length)})`}
            </button>
          )}
          <button
            type="button"
            onClick={next}
            disabled={!anyConnected}
            style={buttonStyle("primary", !anyConnected)}
          >
            Continue →
          </button>
        </div>
      </div>
    </div>
  );
}

function Tile({
  s,
  isConnected,
  isSelected,
  status,
  onToggle,
  onConnected,
}: {
  readonly s: Suggestion;
  readonly isConnected: boolean;
  readonly isSelected: boolean;
  readonly status: AuthStatus | undefined;
  readonly onToggle: () => void;
  readonly onConnected: () => void;
}): ReactNode {
  const header = (
    <>
      <div style={{ fontSize: 13, marginBottom: 4 }}>
        {(isSelected || isConnected) && <span aria-hidden="true">✓ </span>}
        <span>{s.displayName}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--color-fg-muted)" }}>{s.description}</div>
    </>
  );
  if (isConnected) {
    return (
      <div style={cardStyle(true)}>
        {header}
        <div style={{ fontSize: 11, marginTop: 6, color: STATUS_COLOR.connected }}>Connected</div>
      </div>
    );
  }
  if (s.signIn === "browser") {
    return (
      <button type="button" onClick={onToggle} style={cardStyle(isSelected)}>
        {header}
        {status !== undefined && (
          <div style={{ fontSize: 11, marginTop: 6, color: STATUS_COLOR[status] }}>
            {STATUS_LABEL[status]}
          </div>
        )}
      </button>
    );
  }
  if (s.signIn === "atlassian") {
    return (
      <div style={cardStyle(false)}>
        {header}
        <AtlassianForm serviceId={s.id} displayName={s.displayName} onConnected={onConnected} />
      </div>
    );
  }
  return (
    <div style={cardStyle(false)}>
      {header}
      <div style={{ fontSize: 11, marginTop: 6 }}>Set up from a terminal:</div>
      <code style={{ fontSize: 11, userSelect: "all" }}>{`nimbus connector auth ${s.id}`}</code>
      <div style={{ fontSize: 11, marginTop: 4, color: "var(--color-fg-muted)" }}>
        We'll notice when it's connected.
      </div>
    </div>
  );
}
