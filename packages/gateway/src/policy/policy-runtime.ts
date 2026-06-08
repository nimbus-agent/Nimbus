import type { PolicyBundle } from "./policy-distribution.ts";
import { type PolicyGate, verifyCandidate } from "./policy-gate.ts";
import type { PolicyStore } from "./policy-store.ts";
import { parsePolicyToml } from "./policy-toml.ts";

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
  readonly reason?: "no_bundle" | "bad_signature";
}

/** Canonical form of a connector allowlist for change detection: deduped + sorted, or null. */
function normalizeAllowlist(allow: readonly string[] | undefined): string[] | null {
  if (allow === undefined) return null;
  return [...new Set(allow)].sort();
}

/** Peer refresh: fetch → verify → persist → re-enforce. Fail-closed on bad sig (keep last-valid). */
export async function refreshPolicy(deps: RefreshDeps): Promise<RefreshOutcome> {
  const bundle = await deps.fetch();
  if (bundle === null) return { applied: false, reason: "no_bundle" };
  const parsed = verifyCandidate(bundle.toml, bundle.sig, deps.pinnedPubkey);
  if (parsed === null) return { applied: false, reason: "bad_signature" }; // keep last-valid

  const prev = deps.store.load();
  // pendingRestart only when the connector allowlist changes (sync re-registration is boot-time;
  // tool-exposure is already live for other policy fields).
  let prevAllow: readonly string[] | undefined;
  if (prev !== undefined) {
    try {
      prevAllow = parsePolicyToml(prev.toml).connectors.allow;
    } catch {
      // A malformed persisted copy must not abort applying a newly-valid bundle.
      prevAllow = undefined;
    }
  }
  // Compare canonically (deduped + sorted) so a mere reorder of the allowlist does not
  // trigger an unnecessary pendingRestart.
  const connectorAllowChanged =
    JSON.stringify(normalizeAllowlist(prevAllow)) !==
    JSON.stringify(normalizeAllowlist(parsed.connectors.allow));
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
