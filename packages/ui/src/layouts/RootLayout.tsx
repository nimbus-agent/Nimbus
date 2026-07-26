import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useCallback, useEffect } from "react";
import { Outlet, useNavigate } from "react-router";
import { Sidebar } from "../components/chrome/Sidebar";
import { GatewayOfflineBanner } from "../components/GatewayOfflineBanner";
import { HotkeyFailedBanner } from "../components/HotkeyFailedBanner";
import { UpdaterRestartChrome } from "../components/updater/UpdaterRestartChrome";
import { useIpcSubscription } from "../hooks/useIpcSubscription";
import type { HitlRequest } from "../ipc/types";
import { restartApp } from "../lib/restart";
import { useNimbusStore } from "../store";

interface ConsentRequestPayload {
  request_id: string;
  prompt: string;
  details?: Record<string, unknown>;
  received_at_ms: number;
}

interface ConsentResolvedPayload {
  request_id: string;
  approved: boolean;
}

export function RootLayout() {
  const connectionState = useNimbusStore((s) => s.connectionState);
  const aggregateHealth = useNimbusStore((s) => s.aggregateHealth);
  const pendingHitl = useNimbusStore((s) => s.pendingHitl);
  const setPendingHitl = useNimbusStore((s) => s.setPendingHitl);
  const pending = useNimbusStore((s) => s.pending);
  const enqueue = useNimbusStore((s) => s.enqueue);
  const resolveHitl = useNimbusStore((s) => s.resolve);
  const requestHighlight = useNimbusStore((s) => s.requestHighlight);
  const clearHighlight = useNimbusStore((s) => s.clearHighlight);
  const offline = connectionState === "disconnected";
  const navigate = useNavigate();

  useEffect(() => {
    emit("tray://state-changed", { icon: aggregateHealth, badge: pendingHitl }).catch(
      () => undefined,
    );
  }, [aggregateHealth, pendingHitl]);

  useEffect(() => {
    setPendingHitl(pending.length);
  }, [pending.length, setPendingHitl]);

  const onTrayConnector = useCallback(
    (p: { readonly name: string }) => {
      navigate("/");
      requestHighlight(p.name);
      setTimeout(() => clearHighlight(), 1500);
    },
    [navigate, requestHighlight, clearHighlight],
  );
  useIpcSubscription<{ name: string }>("tray://open-connector", onTrayConnector);

  const onConsentRequest = useCallback(
    (p: ConsentRequestPayload) => {
      const request: HitlRequest = {
        requestId: p.request_id,
        prompt: p.prompt,
        receivedAtMs: p.received_at_ms,
      };
      if (p.details !== undefined) request.details = p.details;
      enqueue(request);
    },
    [enqueue],
  );
  useIpcSubscription<ConsentRequestPayload>("consent://request", onConsentRequest);

  const onConsentResolved = useCallback(
    (p: ConsentResolvedPayload) => {
      resolveHitl(p.request_id, p.approved);
    },
    [resolveHitl],
  );
  useIpcSubscription<ConsentResolvedPayload>("consent://resolved", onConsentResolved);

  const onProfileSwitched = useCallback(() => {
    void restartApp();
  }, []);
  useIpcSubscription<{ name: string }>("profile://switched", onProfileSwitched);

  useEffect(() => {
    invoke<ConsentRequestPayload[]>("get_pending_hitl")
      .then((list) => {
        for (const p of list ?? []) {
          const request: HitlRequest = {
            requestId: p.request_id,
            prompt: p.prompt,
            receivedAtMs: p.received_at_ms,
          };
          if (p.details !== undefined) request.details = p.details;
          enqueue(request);
        }
      })
      .catch(() => undefined);
    // Run once on mount only; enqueue is stable from zustand.
  }, [enqueue]);

  return (
    <div className="h-screen flex flex-col">
      {offline && <GatewayOfflineBanner />}
      <HotkeyFailedBanner />
      <UpdaterRestartChrome />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
