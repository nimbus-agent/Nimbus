import { type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { createIpcClient } from "../../ipc/client";
import { packFor, roleChoices } from "../../onboarding/role-choices";
import { useNimbusStore } from "../../store";
import { buttonStyle, cardStyle, StepLabel } from "./onboarding-ui";

/**
 * "What do you do?" — one card per role pack the gateway lists, then Engineering, Design and
 * Something else. A pack not yet installed goes to the Pack step; everything else to Connect.
 */
export function Role(): ReactNode {
  const navigate = useNavigate();
  const setChosenPack = useNimbusStore((s) => s.setChosenPack);
  const [packList, setPackList] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    createIpcClient()
      .call<unknown>("pack.list", {})
      .then((r) => {
        if (live) setPackList(r);
      })
      .catch(() => {
        // No packs to offer: the three fixed answers still work.
      });
    return () => {
      live = false;
    };
  }, []);

  const pick = (value: string): void => {
    const pack = packFor(value, packList);
    setChosenPack(pack?.id ?? null);
    void navigate(
      pack !== undefined && !pack.installed ? "/onboarding/pack" : "/onboarding/connect",
    );
  };

  return (
    <div>
      <StepLabel>Step 2</StepLabel>
      <h2 style={{ marginTop: 0 }}>What do you do?</h2>
      <p style={{ color: "var(--color-fg-muted)" }}>
        Nimbus sets itself up for your role. You can change this later.
      </p>
      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 18 }}
      >
        {roleChoices(packList).map((c) => (
          <button
            type="button"
            key={c.value}
            onClick={() => pick(c.value)}
            style={cardStyle(false)}
          >
            <div style={{ fontSize: 13, marginBottom: 4 }}>{c.label}</div>
            {c.description !== undefined && (
              <div style={{ fontSize: 11, color: "var(--color-fg-muted)" }}>{c.description}</div>
            )}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-start", marginTop: 32 }}>
        <button
          type="button"
          onClick={() => navigate("/onboarding/welcome")}
          style={buttonStyle("outline")}
        >
          ← Back
        </button>
      </div>
    </div>
  );
}
