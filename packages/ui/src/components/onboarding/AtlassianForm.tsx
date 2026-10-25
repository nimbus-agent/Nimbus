import type React from "react";
import { type ReactNode, useState } from "react";
import { createIpcClient } from "../../ipc/client";
import { buttonStyle, plainError } from "../../pages/onboarding/onboarding-ui";

const INPUT: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-border)",
  background: "var(--color-surface)",
  color: "var(--color-fg)",
  fontSize: 12,
  marginTop: 4,
};

/**
 * Jira / Confluence sign-in: account email, API token and site URL, sent ONCE to `connector.auth`
 * (the same method the browser tiles call) and the token cleared from state whatever the answer.
 * The token never leaves this component except in that one call.
 */
export function AtlassianForm({
  serviceId,
  displayName,
  onConnected,
}: {
  readonly serviceId: string;
  readonly displayName: string;
  readonly onConnected: () => void;
}): ReactNode {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [site, setSite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = email.trim() !== "" && token.trim() !== "" && site.trim() !== "" && !busy;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await createIpcClient().call("connector.auth", {
        service: serviceId,
        atlassianEmail: email.trim(),
        apiToken: token,
        apiBaseUrl: site.trim(),
      });
      onConnected();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setToken("");
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8, fontSize: 12 }}>
      <label style={{ display: "block" }}>
        Email
        <input
          aria-label={`${displayName} email`}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={INPUT}
        />
      </label>
      <label style={{ display: "block", marginTop: 6 }}>
        API token
        <input
          aria-label={`${displayName} API token`}
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={INPUT}
        />
      </label>
      <label style={{ display: "block", marginTop: 6 }}>
        Site URL
        <input
          aria-label={`${displayName} site URL`}
          type="url"
          placeholder="https://your-domain.atlassian.net"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          style={INPUT}
        />
      </label>
      {error !== null && (
        <div role="alert" style={{ color: "var(--color-error)", marginTop: 6 }}>
          {error}
        </div>
      )}
      <button
        type="button"
        disabled={!ready}
        onClick={() => void submit()}
        style={{ ...buttonStyle("primary", !ready), marginTop: 8, padding: "4px 12px" }}
      >
        {busy ? "Connecting…" : `Connect ${displayName}`}
      </button>
    </div>
  );
}
