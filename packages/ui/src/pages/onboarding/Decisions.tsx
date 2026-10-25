import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { createIpcClient } from "../../ipc/client";
import { suggestionsFrom } from "../../onboarding/connect-suggestions";
import {
  asDecisionStatus,
  type ConnectorProgress,
  type DecisionStatus,
  decisionsView,
} from "../../onboarding/decisions-progress";
import { buttonStyle, StepLabel } from "./onboarding-ui";

const POLL_MS = 3000;
/** "Widen the window": a year, in the duration form `agents.decisions` takes. */
const WIDE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The suggested connectors that are connected, with their sync progress. */
function progressOf(
  names: ReadonlyMap<string, string>,
  statuses: unknown,
): readonly ConnectorProgress[] {
  const out: ConnectorProgress[] = [];
  for (const raw of Array.isArray(statuses) ? statuses : []) {
    if (!isRecord(raw)) continue;
    const id = raw["serviceId"];
    const health = raw["healthState"];
    // Before the catalog answers there are no names: show every connected connector then.
    if (typeof id !== "string" || (names.size > 0 && !names.has(id))) continue;
    if (typeof health !== "string" || health === "unauthenticated") continue;
    const itemCount = raw["itemCount"];
    const lastSyncAt = raw["lastSyncAt"];
    out.push({
      id,
      displayName: names.get(id) ?? id,
      status: typeof raw["status"] === "string" ? raw["status"] : "ok",
      itemCount: typeof itemCount === "number" ? itemCount : 0,
      lastSyncAt: typeof lastSyncAt === "number" ? lastSyncAt : null,
    });
  }
  return out;
}

/**
 * The last onboarding step for a role whose pack shows Decisions: live progress while the
 * connectors sync and the pass mines them, the decisions as they are found, or — when the pass
 * found none — what it read and why nothing qualified, with the next steps that could change it.
 */
export function Decisions(): ReactNode {
  const navigate = useNavigate();
  const [status, setStatus] = useState<DecisionStatus | null>(null);
  const [connectors, setConnectors] = useState<readonly ConnectorProgress[]>([]);
  const names = useRef<ReadonlyMap<string, string>>(new Map());
  const completed = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    const client = createIpcClient();
    let live = true;
    const tick = async (): Promise<void> => {
      if (inFlight.current || document.visibilityState === "hidden") return;
      inFlight.current = true;
      try {
        const [s, statuses] = await Promise.all([
          client.call<unknown>("decisions.status", {}),
          client.call<unknown>("connector.listStatus", {}),
        ]);
        if (!live) return;
        setStatus(asDecisionStatus(s));
        setConnectors(progressOf(names.current, statuses));
      } catch {
        // transient: keep the last answer and try again on the next tick
      } finally {
        inFlight.current = false;
      }
    };
    // Leaving this step by closing or hiding the window still completes onboarding, as the
    // Syncing step does: the user saw the end of it.
    const markComplete = (): void => {
      if (completed.current) return;
      completed.current = true;
      void client
        .call("db.setMeta", { key: "onboarding_completed", value: new Date().toISOString() })
        .catch(() => undefined);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") markComplete();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void client
      .call<unknown>("catalog.list", {})
      .then((catalog) => {
        names.current = new Map(suggestionsFrom(catalog).map((x) => [x.id, x.displayName]));
      })
      .catch(() => undefined)
      .finally(() => void tick());
    const iv = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisibility);
      markComplete();
    };
  }, []);

  const finish = async (to: string): Promise<void> => {
    if (!completed.current) {
      completed.current = true;
      try {
        await createIpcClient().call("db.setMeta", {
          key: "onboarding_completed",
          value: new Date().toISOString(),
        });
      } catch {
        // onboarding still ends; the dashboard is reachable either way
      }
    }
    await navigate(to, { replace: true });
  };

  const view = decisionsView(status, connectors);

  return (
    <div>
      <StepLabel>Decisions</StepLabel>
      <h2 style={{ marginTop: 0 }}>Decisions</h2>
      {view.syncLines.length > 0 && (
        <ul style={{ fontSize: 12, color: "var(--color-fg-muted)", paddingLeft: 18 }}>
          {view.syncLines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <p role="status">{view.headline}</p>
      {view.reason !== undefined && <p>{view.reason}</p>}
      {(status?.recent.length ?? 0) > 0 && (
        <ul style={{ lineHeight: 1.6 }}>
          {status?.recent.map((d, i) => (
            <li key={`${String(i)}:${String(d.at)}`}>{d.statement}</li>
          ))}
        </ul>
      )}
      {view.phase === "none" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            onClick={() => void finish("/settings/connectors")}
            style={buttonStyle("outline")}
          >
            Add a channel
          </button>
          <button
            type="button"
            onClick={() => void navigate("/onboarding/connect")}
            style={buttonStyle("outline")}
          >
            Connect Notion or Google Drive
          </button>
          <button
            type="button"
            onClick={() => void finish(`/briefs/decisions?sinceMs=${String(WIDE_WINDOW_MS)}`)}
            style={buttonStyle("outline")}
          >
            Widen the window
          </button>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 32 }}>
        {view.phase === "found" && (
          <button
            type="button"
            onClick={() => void finish("/briefs/decisions")}
            style={buttonStyle("outline")}
          >
            Open Decisions
          </button>
        )}
        <button type="button" onClick={() => void finish("/")} style={buttonStyle("primary")}>
          Open dashboard →
        </button>
      </div>
    </div>
  );
}
