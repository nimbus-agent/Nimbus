import { createContext, useContext } from "react";
import type { BriefRun } from "../briefs/brief-runs";

export interface BriefRunsApi {
  latest(agent: string): BriefRun | undefined;
  /** Calls `agents.<agent>` and registers the returned session; a rejected call registers nothing. */
  start(agent: string, params: Record<string, unknown>): Promise<void>;
}

export const BriefRunsContext = createContext<BriefRunsApi | null>(null);

export function useBriefRuns(): BriefRunsApi {
  const v = useContext(BriefRunsContext);
  if (v === null) throw new Error("useBriefRuns must be used inside <BriefRunsProvider>");
  return v;
}
