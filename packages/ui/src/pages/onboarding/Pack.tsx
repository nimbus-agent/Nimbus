import { type ReactNode, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { createIpcClient } from "../../ipc/client";
import { type PackRow, packRows } from "../../onboarding/role-choices";
import { useNimbusStore } from "../../store";
import { buttonStyle, plainError, StepLabel } from "./onboarding-ui";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `id → display name` from `catalog.list` (agents by name, connectors by id). */
function displayNames(catalog: unknown, key: "agents" | "connectors"): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const list = isRecord(catalog) ? catalog[key] : undefined;
  for (const raw of Array.isArray(list) ? list : []) {
    if (!isRecord(raw)) continue;
    const label = raw["displayName"] ?? raw["name"];
    if (typeof label !== "string") continue;
    // An installed extension is suggested by its service id (`ext_*`), not its package id.
    const keys = key === "agents" ? [raw["name"]] : [raw["id"], raw["serviceId"]];
    for (const id of keys) if (typeof id === "string") out.set(id, label);
  }
  return out;
}

type Phase = "idle" | "waiting" | "failed";

/**
 * The pack the Role step chose, summarised in plain words, installed only when the owner clicks
 * Continue — and then only through `pack.install`, whose approval popup shows the exact text.
 */
export function Pack(): ReactNode {
  const navigate = useNavigate();
  // Read once: "Continue without the pack" clears the store's choice on its way out, and this page
  // must not redirect in that instant.
  const [chosenPackId] = useState(() => useNimbusStore.getState().chosenPackId);
  const setChosenPack = useNimbusStore((s) => s.setChosenPack);
  const [pack, setPack] = useState<PackRow | undefined>(undefined);
  const [catalog, setCatalog] = useState<unknown>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const client = createIpcClient();
    void Promise.all([
      client.call<unknown>("pack.list", {}).catch(() => null),
      client.call<unknown>("catalog.list", {}).catch(() => null),
    ]).then(([packList, cat]) => {
      if (!live) return;
      setPack(packRows(packList).find((p) => p.id === chosenPackId));
      setCatalog(cat);
    });
    return () => {
      live = false;
    };
  }, [chosenPackId]);

  if (chosenPackId === null) {
    return <Navigate to="/onboarding/role" replace />;
  }
  const name = pack?.name ?? chosenPackId;
  const connectors = displayNames(catalog, "connectors");
  const agents = displayNames(catalog, "agents");
  const suggests = (pack?.suggestedConnectors ?? []).map((id) => connectors.get(id) ?? id);
  const shows = (pack?.visibleAgents ?? []).map((id) => agents.get(id) ?? id);

  const install = async (): Promise<void> => {
    if (phase === "waiting") return;
    setPhase("waiting");
    setError(null);
    try {
      await createIpcClient().call("pack.install", { id: chosenPackId });
      void navigate("/onboarding/connect");
    } catch (e) {
      setPhase("failed");
      setError(plainError(e));
    }
  };

  const skip = (): void => {
    setChosenPack(null);
    void navigate("/onboarding/connect");
  };

  return (
    <div>
      <StepLabel>Pack</StepLabel>
      <h2 style={{ marginTop: 0 }}>{`Set up Nimbus for ${name}`}</h2>
      {pack?.description !== undefined && <p>{pack.description}</p>}
      {suggests.length > 0 && <p>{`Suggests: ${suggests.join(", ")}`}</p>}
      {shows.length > 0 && <p>{`Shows: ${shows.join(", ")}`}</p>}
      <p style={{ color: "var(--color-fg-muted)" }}>
        You'll be asked to approve exactly what it changes. Your own settings always win.
      </p>
      {phase === "waiting" && <p role="status">Waiting for your approval…</p>}
      {phase === "failed" && error !== null && (
        <p role="alert" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32, gap: 8 }}>
        <button
          type="button"
          onClick={() => navigate("/onboarding/role")}
          style={buttonStyle("outline")}
        >
          ← Back
        </button>
        <button type="button" onClick={skip} style={buttonStyle("ghost")}>
          Continue without the pack
        </button>
        <button
          type="button"
          onClick={() => void install()}
          disabled={phase === "waiting"}
          style={buttonStyle("primary", phase === "waiting")}
        >
          Continue →
        </button>
      </div>
    </div>
  );
}
