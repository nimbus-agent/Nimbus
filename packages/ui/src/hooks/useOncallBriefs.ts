import { createContext, useContext } from "react";
import type { JsonRpcNotification, PushedBriefGet, PushedBriefList } from "../ipc/types";

export interface OncallBriefsState {
  readonly list: PushedBriefList | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  /** The last `oncall.briefPushed` with a usable id; `seq` advances on EVERY such event. */
  readonly lastPushed: { readonly incidentId: string; readonly seq: number } | null;
  refetch: () => void;
}

export const OncallBriefsContext = createContext<OncallBriefsState | null>(null);

export function useOncallBriefs(): OncallBriefsState {
  const v = useContext(OncallBriefsContext);
  if (v === null) throw new Error("useOncallBriefs must be used inside <OncallBriefsProvider>");
  return v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `null` = not a pushed-brief event. A match with an unusable payload carries a null id. */
export function parseBriefPushed(
  n: JsonRpcNotification,
): { readonly incidentId: string | null } | null {
  if (n.method !== "gateway.event" || !isRecord(n.params)) return null;
  if (n.params["kind"] !== "oncall.briefPushed") return null;
  const payload = n.params["payload"];
  const id = isRecord(payload) ? payload["incidentId"] : undefined;
  return { incidentId: typeof id === "string" && id !== "" ? id : null };
}

/** Shallow: the fixture-backed contract test pins the full shape on the gateway side. */
export function asPushedBriefList(v: unknown): PushedBriefList | null {
  if (!isRecord(v) || typeof v["enabled"] !== "boolean" || !Array.isArray(v["briefs"])) {
    return null;
  }
  return v as unknown as PushedBriefList;
}

/**
 * THREE states, deliberately: `undefined` = nothing usable yet (loading, or not this shape);
 * `{ brief: null }` = the gateway answered and the brief is gone (pruned): BriefDetail reports it;
 * `{ brief: … }` = a brief. Collapsing the first two would announce "pruned" while still loading.
 */
export function asPushedBriefGet(v: unknown): PushedBriefGet | undefined {
  if (!isRecord(v) || !("brief" in v)) return undefined;
  const b = v["brief"];
  if (b === null) return { brief: null };
  return isRecord(b) && typeof b["incidentId"] === "string"
    ? (v as unknown as PushedBriefGet)
    : undefined;
}
