import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { PolicyBundle } from "./policy-distribution.ts";
import type { PolicyGate } from "./policy-gate.ts";
import { signPolicy } from "./policy-signing.ts";
import type { PolicyStore } from "./policy-store.ts";
import { parsePolicyToml } from "./policy-toml.ts";

/**
 * Dependencies for {@link authorPolicy}. Injected so the helper unit-tests without Vault/HTTP:
 * the caller resolves the anchor keypair (Vault-only) and threads the base64 strings in. The
 * privkey lives in this struct ONLY for the duration of the signing call — it is NEVER persisted,
 * returned, or logged (I22 / no-plaintext-credentials).
 */
export interface AuthorDeps {
  readonly store: PolicyStore;
  readonly gate: PolicyGate;
  readonly db: Database;
  readonly privkeyB64: string;
  readonly pubkeyB64: string;
  readonly nowMs: number;
}

export type AuthorResult =
  | { ok: true; bundle: PolicyBundle; org: string; version: number }
  | { ok: false; error: string };

/**
 * Validate, sign (with the anchor key), persist (source="anchor"), self-pin the anchor pubkey,
 * apply to the live gate, and audit. The returned bundle is the PUBLIC {toml, sig} pair — it never
 * contains the privkey. This is the single anchor-side write path for org policy (D16-resident: it
 * is the only non-policy/ caller's gateway into parsePolicyToml).
 */
export function authorPolicy(deps: AuthorDeps, toml: string): AuthorResult {
  let parsed: ReturnType<typeof parsePolicyToml>;
  try {
    parsed = parsePolicyToml(toml);
  } catch {
    return { ok: false, error: "policy TOML is malformed" };
  }
  if (parsed.org.trim() === "") return { ok: false, error: "policy.org is required" };
  if (parsed.version < 1) return { ok: false, error: "policy.version must be >= 1" };

  const sig = signPolicy(toml, deps.privkeyB64);
  const persisted = {
    toml,
    sig,
    org: parsed.org,
    version: parsed.version,
    ...(parsed.issuedAt === undefined ? {} : { issuedAt: parsed.issuedAt }),
    fetchedAt: deps.nowMs,
    source: "anchor" as const,
  };
  // The anchor governs itself: pin its own pubkey so the gate's verify path (and any rehydrate)
  // accepts the policy it just signed.
  deps.store.pinAnchorPubkey(deps.pubkeyB64, "manual", deps.nowMs);
  deps.store.persist(persisted);
  deps.gate.applyVerified(parsed, persisted, false);

  appendAuditEntry(deps.db, {
    actionType: "policy.applied",
    hitlStatus: "not_required",
    actionJson: JSON.stringify({ org: parsed.org, version: parsed.version, source: "anchor" }),
    timestamp: deps.nowMs,
  });

  return { ok: true, bundle: { toml, sig }, org: parsed.org, version: parsed.version };
}
