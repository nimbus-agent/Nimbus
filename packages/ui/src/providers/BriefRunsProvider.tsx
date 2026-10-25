import { type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  applyOutcome,
  type BriefOutcome,
  type BriefRunsState,
  emptyBriefRuns,
  latestRun,
  parseBriefNotification,
  registerRun,
} from "../briefs/brief-runs";
import { type BriefRunsApi, BriefRunsContext } from "../hooks/useBriefRuns";
import { createIpcClient } from "../ipc/client";

type Action =
  | { type: "register"; agent: string; sessionId: string; now: number }
  | { type: "outcome"; sessionId: string; outcome: BriefOutcome; now: number };

function reduce(s: BriefRunsState, a: Action): BriefRunsState {
  return a.type === "register"
    ? registerRun(s, a.agent, a.sessionId, a.now)
    : applyOutcome(s, a.sessionId, a.outcome, a.now);
}

function sessionIdOf(res: unknown): string | null {
  if (res === null || typeof res !== "object") return null;
  const id = (res as Record<string, unknown>)["sessionId"];
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Owns brief runs for the whole app (spec § 5.5). It subscribes once on mount and `start` awaits that
 * subscription before calling the gateway, so a `<agent>.briefReady` that beats the call's own
 * resolution is buffered by the pure store instead of lost.
 */
export function BriefRunsProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(reduce, undefined, emptyBriefRuns);
  const subscribed = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const p = createIpcClient()
      .subscribe((n) => {
        const parsed = parseBriefNotification(n);
        if (parsed !== null) dispatch({ type: "outcome", ...parsed, now: Date.now() });
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    // `start` awaits `p` and so sees a rejection; this no-op only silences the unhandled-rejection warning.
    p.catch(() => undefined);
    subscribed.current = p;
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const start = useCallback(async (agent: string, params: Record<string, unknown>) => {
    try {
      await subscribed.current;
    } catch (e) {
      // No listener means no result could ever arrive: fail now rather than sit pending.
      throw e instanceof Error ? e : new Error(String(e));
    }
    let res: unknown;
    try {
      res = await createIpcClient().call<unknown>(`agents.${agent}`, params);
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
    const sessionId = sessionIdOf(res);
    if (sessionId === null) throw new Error(`agents.${agent} returned no sessionId`);
    dispatch({ type: "register", agent, sessionId, now: Date.now() });
  }, []);

  const value = useMemo<BriefRunsApi>(
    () => ({ latest: (agent) => latestRun(state, agent), start }),
    [state, start],
  );
  return <BriefRunsContext.Provider value={value}>{children}</BriefRunsContext.Provider>;
}
