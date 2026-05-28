import { useCallback, useEffect, useRef, useState } from "react";
import { createIpcClient } from "../ipc/client";
import { useNimbusStore } from "../store";

export interface UseIpcQueryResult<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  refetch: () => void;
}

interface Options {
  enabled?: boolean;
}

export function useIpcQuery<T>(
  method: string,
  intervalMs: number,
  params?: Record<string, unknown>,
  opts: Options = {},
): UseIpcQueryResult<T> {
  const enabled = opts.enabled ?? true;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const paramsKey = JSON.stringify(params ?? {});
  const generationRef = useRef(0);
  const connectionState = useNimbusStore((s) => s.connectionState);

  // biome-ignore lint/correctness/useExhaustiveDependencies: paramsKey proxies params
  const run = useCallback(async () => {
    const gen = ++generationRef.current;
    setIsLoading(true);
    try {
      const res = await createIpcClient().call<T>(method, params ?? {});
      if (gen !== generationRef.current) return;
      setData(res);
      setError(null);
    } catch (e) {
      if (gen !== generationRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === generationRef.current) setIsLoading(false);
    }
  }, [method, paramsKey]);

  useEffect(() => {
    if (!enabled) return;
    if (connectionState !== "connected") return;
    if (document.visibilityState === "hidden") return;

    run().catch(() => undefined);
    const id = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (connectionState !== "connected") return;
      run().catch(() => undefined);
    }, intervalMs);

    const onVis = () => {
      if (document.visibilityState === "visible") run().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, connectionState, intervalMs, run]);

  return { data, error, isLoading, refetch: run };
}
