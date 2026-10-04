import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useIpcQuery } from "../hooks/useIpcQuery";
import {
  asPushedBriefList,
  OncallBriefsContext,
  type OncallBriefsState,
  parseBriefPushed,
} from "../hooks/useOncallBriefs";
import { createIpcClient } from "../ipc/client";
import type { JsonRpcNotification } from "../ipc/types";

/**
 * Owns the ONE pushed-brief list query and the ONE gateway-notification subscription for the app
 * (spec § 2.2), so the sidebar dot and the On-call page never double-fetch on an event. The 60 s
 * poll is the backstop for events missed while the bridge reconnects; `useIpcQuery` also re-runs
 * when the connection returns to `connected`.
 */
export function OncallBriefsProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const { data, error, isLoading, refetch } = useIpcQuery<unknown>("oncall.pushedList", 60_000, {
    limit: 50,
  });
  const [lastPushed, setLastPushed] = useState<OncallBriefsState["lastPushed"]>(null);

  const onNotification = useCallback(
    (n: JsonRpcNotification) => {
      const ev = parseBriefPushed(n);
      if (ev === null) return;
      refetch();
      const id = ev.incidentId;
      if (id !== null) setLastPushed((prev) => ({ incidentId: id, seq: (prev?.seq ?? 0) + 1 }));
    },
    [refetch],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void createIpcClient()
      .subscribe(onNotification)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [onNotification]);

  const value = useMemo<OncallBriefsState>(
    () => ({ list: asPushedBriefList(data), error, isLoading, lastPushed, refetch }),
    [data, error, isLoading, lastPushed, refetch],
  );
  return <OncallBriefsContext.Provider value={value}>{children}</OncallBriefsContext.Provider>;
}
