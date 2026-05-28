import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIpcSubscription } from "../../hooks/useIpcSubscription";
import { createIpcClient } from "../../ipc/client";
import type {
  JsonRpcNotification,
  UpdaterDownloadProgressPayload,
  UpdaterRestartingPayload,
  UpdaterRolledBackPayload,
  UpdaterVerifyFailedPayload,
} from "../../ipc/types";
import { useNimbusStore } from "../../store";
import { RestartOverlay } from "../settings/updater/RestartOverlay";

const RECONNECT_TIMEOUT_MS = 2 * 60 * 1_000;

export function UpdaterRestartChrome() {
  const uiState = useNimbusStore((s) => s.updaterUiState);
  const restarting = useNimbusStore((s) => s.updaterRestarting);
  const setUiState = useNimbusStore((s) => s.setUpdaterUiState);
  const setCheck = useNimbusStore((s) => s.setUpdaterCheck);
  const setDownload = useNimbusStore((s) => s.setUpdaterDownload);
  const setRestarting = useNimbusStore((s) => s.setUpdaterRestarting);
  const setFailure = useNimbusStore((s) => s.setUpdaterFailure);
  const setStatus = useNimbusStore((s) => s.setUpdaterStatus);

  const reconnectStartRef = useRef<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (uiState !== "reconnecting") {
      reconnectStartRef.current = null;
      setElapsedSec(0);
      return;
    }
    reconnectStartRef.current = Date.now();
    setElapsedSec(0);
    const id = setInterval(() => {
      const start = reconnectStartRef.current;
      if (start === null) return;
      const elapsed = Math.floor((Date.now() - start) / 1_000);
      setElapsedSec(elapsed);
      if (Date.now() - start >= RECONNECT_TIMEOUT_MS) {
        clearInterval(id);
        setFailure({ reason: "reconnect_timeout" });
        setUiState("failed");
        invoke("updater_apply_finished").catch(() => undefined);
      }
    }, 1_000);
    return () => clearInterval(id);
  }, [uiState, setFailure, setUiState]);

  const onNotification = useCallback(
    (n: JsonRpcNotification) => {
      switch (n.method) {
        case "updater.updateAvailable":
          void createIpcClient()
            .updaterCheckNow()
            .then((c) => {
              setCheck(c);
              setUiState("available");
            })
            .catch(() => undefined);
          return;
        case "updater.downloadProgress":
          setDownload(n.params as UpdaterDownloadProgressPayload);
          if (useNimbusStore.getState().updaterUiState !== "downloading") {
            setUiState("downloading");
          }
          return;
        case "updater.restarting":
          setRestarting(n.params as UpdaterRestartingPayload);
          setUiState("restarting");
          return;
        case "updater.rolledBack":
          setFailure(n.params as UpdaterRolledBackPayload);
          setUiState("rolled_back");
          invoke("updater_apply_finished").catch(() => undefined);
          return;
        case "updater.verifyFailed":
          setFailure(n.params as UpdaterVerifyFailedPayload);
          setUiState("failed");
          invoke("updater_apply_finished").catch(() => undefined);
          return;
        default:
          return;
      }
    },
    [setCheck, setDownload, setRestarting, setFailure, setUiState],
  );
  useIpcSubscription<JsonRpcNotification>("gateway://notification", onNotification);

  const onRestartStarted = useCallback(() => {
    setUiState("reconnecting");
  }, [setUiState]);
  useIpcSubscription<unknown>("updater://restart-started", onRestartStarted);

  const onRestartComplete = useCallback(() => {
    (async () => {
      try {
        const version = await createIpcClient().diagGetVersion();
        const latest = useNimbusStore.getState().updaterRestarting;
        const expected = latest?.toVersion ?? null;
        if (expected !== null && version.version === expected) {
          setUiState("success");
          try {
            const next = await createIpcClient().updaterGetStatus();
            setStatus(next);
          } catch {
            /* non-fatal */
          }
        } else {
          setFailure({ reason: "installer_failed" });
          setUiState("rolled_back");
        }
      } catch {
        setFailure({ reason: "installer_failed" });
        setUiState("failed");
      } finally {
        invoke("updater_apply_finished").catch(() => undefined);
      }
    })();
  }, [setFailure, setStatus, setUiState]);
  useIpcSubscription<unknown>("updater://restart-complete", onRestartComplete);

  return <RestartOverlay state={uiState} restarting={restarting} elapsedSec={elapsedSec} />;
}
