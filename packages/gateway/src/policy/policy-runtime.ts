import type { PolicyBundle } from "./policy-distribution.ts";
import { type PolicyGate, verifyCandidate } from "./policy-gate.ts";
import type { PolicyStore } from "./policy-store.ts";

export interface RefreshDeps {
  readonly store: PolicyStore;
  readonly gate: PolicyGate;
  readonly pinnedPubkey: string;
  readonly nowMs: number;
  readonly fetch: () => Promise<PolicyBundle | null>;
  readonly onConnectorAllowChanged?: () => void; // marks pendingRestart
}

export interface RefreshOutcome {
  readonly applied: boolean;
  readonly reason?: "no_bundle" | "bad_signature" | "unchanged";
}

/** Peer refresh: fetch → verify → persist → re-enforce. Fail-closed on bad sig (keep last-valid). */
export async function refreshPolicy(deps: RefreshDeps): Promise<RefreshOutcome> {
  const bundle = await deps.fetch();
  if (bundle === null) return { applied: false, reason: "no_bundle" };
  const parsed = verifyCandidate(bundle.toml, bundle.sig, deps.pinnedPubkey);
  if (parsed === null) return { applied: false, reason: "bad_signature" }; // keep last-valid

  const prev = deps.store.load();
  // pendingRestart when the connector allowlist changes (sync re-registration is boot-time).
  const prevAllow = JSON.stringify(prev === undefined ? null : prev.toml);
  const connectorAllowChanged = prevAllow !== JSON.stringify(bundle.toml);
  const pendingRestart = connectorAllowChanged && deps.onConnectorAllowChanged !== undefined;

  const persisted = {
    toml: bundle.toml,
    sig: bundle.sig,
    org: parsed.org,
    version: parsed.version,
    ...(parsed.issuedAt === undefined ? {} : { issuedAt: parsed.issuedAt }),
    fetchedAt: deps.nowMs,
    source: "peer" as const,
  };
  deps.store.persist(persisted);
  deps.gate.applyVerified(parsed, persisted, pendingRestart);
  if (pendingRestart) deps.onConnectorAllowChanged?.();
  return { applied: true };
}
