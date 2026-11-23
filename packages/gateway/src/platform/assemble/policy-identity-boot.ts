import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import {
  type loadNimbusAuditFromConfigDir,
  loadNimbusIdentityFromConfigDir,
  loadNimbusQuorumFromConfigDir,
  loadNimbusScimFromConfigDir,
} from "../../config/nimbus-toml.ts";
import { CONNECTOR_SERVICE_IDS } from "../../connectors/connector-catalog.ts";
import { appendAuditEntry } from "../../db/audit-chain.ts";
import { NamespaceStore } from "../../federation/namespace-store.ts";
import { buildIdentityBoot } from "../../identity/identity-boot.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import type { PolicyRpcCtx } from "../../ipc/policy-rpc.ts";
import { ensureAnchorKeypair } from "../../policy/anchor-keypair.ts";
import { connectorAllowPredicate, partitionByAllowlist } from "../../policy/connector-allowlist.ts";
import { startPurge } from "../../policy/gdpr-purge.ts";
import { GdprPurgeStore } from "../../policy/gdpr-purge-store.ts";
import { authorPolicy } from "../../policy/policy-author.ts";
import { servePolicy } from "../../policy/policy-distribution.ts";
import { buildPolicyGate, type PolicyGate } from "../../policy/policy-gate.ts";
import { refreshPolicy } from "../../policy/policy-runtime.ts";
import { PolicyStore } from "../../policy/policy-store.ts";
import { trustAnchorPubkey } from "../../policy/policy-trust.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { HttpSidecarOpts } from "./http-sidecar.ts";

/** How long the chatops local-owner fallback waits for a `nimbus team approve` answer. */
export const CHATOPS_LOCAL_CONSENT_TIMEOUT_MS = 10 * 60 * 1000;

/** Org policy boot (I22): the gate rehydrates last-valid from the store (ungoverned when none). The
 *  baseline is the local floor policy can only TIGHTEN. `policyGate` is the shared instance reused
 *  by the retention floor (Task 8), quorum (Task 9), and the audit shipper (Task 19) — keep it in
 *  scope even though Part C of this task only consumes `enforced().connectorAllow`. Also enforces
 *  the connector allowlist: audits + blocks connectors not permitted by policy. */
export function bootPolicyGateWithConnectorAllowlist(
  db: Database,
  configDir: string,
  auditCfg: ReturnType<typeof loadNimbusAuditFromConfigDir>,
): {
  policyStore: PolicyStore;
  policyGate: PolicyGate;
  isConnectorAllowed: (serviceId: string) => boolean;
} {
  const policyStore = new PolicyStore(db);
  const policyGate = buildPolicyGate(db, policyStore, {
    retentionDays: auditCfg.toolCallLogRetentionDays,
    hitlRequired: new Set<string>(),
    quorum: loadNimbusQuorumFromConfigDir(configDir),
    // Empty by design: the LOCAL kill-switch for an ai_v2 capability is its own config flag
    // (`[code_execution] enabled`), which the exec gate checks separately. This baseline set is the
    // seam an org policy tightens against, and conflating the two would make a local `enabled =
    // true` look like it could argue with a policy lockoff -- which it must never be able to.
    capabilitiesDisabled: new Set<string>(),
  });
  const enforcedConnectorAllow = policyGate.enforced().connectorAllow;
  const { blocked: blockedConnectors } = partitionByAllowlist(
    [...CONNECTOR_SERVICE_IDS],
    enforcedConnectorAllow,
  );
  const blockedAt = Date.now();
  for (const id of blockedConnectors) {
    appendAuditEntry(db, {
      actionType: "policy.connector.blocked",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({ connector: id }),
      timestamp: blockedAt,
    });
  }
  // The live decision, read per call (`connectorAllowPredicate`), never `enforcedConnectorAllow`:
  // that boot-time value only names the connectors audited as blocked above.
  return { policyStore, policyGate, isConnectorAllowed: connectorAllowPredicate(policyGate) };
}

/** Identity & Access (Phase 6 Slice 3). Mirrors the federation block: build the boot, wire the
 *  IPC-facing seams onto ipcOpts, and (when [scim].enabled) hand the SCIM bearer resolver to the
 *  read-only HTTP server so the SCIM provisioning surface authenticates. */
export function bootIdentityIntoIpcOpts(deps: {
  configDir: string;
  localIndex: LocalIndex;
  vault: NimbusVault;
  syncLogger: Logger;
  ipcOpts: Parameters<typeof createIpcServer>[0];
  httpSidecarOpts: HttpSidecarOpts;
}): ReturnType<typeof buildIdentityBoot> | undefined {
  const { configDir, localIndex, vault, syncLogger, ipcOpts, httpSidecarOpts } = deps;
  const identityCfg = loadNimbusIdentityFromConfigDir(configDir);
  const scimCfg = loadNimbusScimFromConfigDir(configDir);
  let identityBoot: ReturnType<typeof buildIdentityBoot> | undefined;
  if (identityCfg.enabled && localIndex !== undefined) {
    identityBoot = buildIdentityBoot(identityCfg, scimCfg, localIndex, vault, {
      log: (m: string) => syncLogger.warn(m),
    });
    ipcOpts.identityStore = identityBoot.store;
    ipcOpts.identityIssuer = identityBoot.issuer;
    ipcOpts.identityGraceSeconds = identityBoot.graceSeconds;
    ipcOpts.identityStartLogin = identityBoot.startLogin;
    ipcOpts.identityVault = vault;
    if (scimCfg.enabled) {
      httpSidecarOpts.resolveScimToken = identityBoot.resolveScimToken;
    }
  }
  return identityBoot;
}

/** Build the policy.* + team.purge IPC context (Task 26, Lanes A–G integration hub). The local IPC
 *  socket is operator/owner-trusted, so isAnchor is true for local calls (signing makes this gateway
 *  an anchor; a purge is operator-only). The GDPR purge deps wire the REAL local-side capabilities:
 *    resolvePeer            → identity binding store (externalId → active peer ids; first wins)
 *    revokeAllGrants        → NamespaceStore.revokeAllForPeer (confirmed grant-revocation sweep)
 *    deleteLocalContributions → same sweep's count (item-level row deletion has no confirmed accessor;
 *                               grant-revocation is the confirmed local effect — see report)
 *    knownPeers             → localIndex.listLanPeers (paired peers fan out one purge request each)
 *  resolvePeer returns undefined when identity is disabled / unbound → startPurge throws (fail-closed). */
export function buildPolicyRpcCtx(deps: {
  db: Database;
  vault: NimbusVault;
  localIndex: LocalIndex;
  policyStore: PolicyStore;
  policyGate: PolicyGate;
  identityBoot: ReturnType<typeof buildIdentityBoot> | undefined;
}): PolicyRpcCtx {
  const { db, vault, localIndex, policyStore, policyGate, identityBoot } = deps;
  const purgeNamespaceStore = new NamespaceStore(db);
  const purgeJobStore = new GdprPurgeStore(db);
  let purgeJobCounter = 0;
  return {
    showPolicy: () => policyGate.status(),
    trustPubkey: ({ pubkey }) => trustAnchorPubkey(policyStore, pubkey, Date.now()),
    refetch: () =>
      refreshPolicy({
        store: policyStore,
        gate: policyGate,
        pinnedPubkey: policyStore.getAnchorPubkey() ?? "",
        nowMs: Date.now(),
        // Best-effort: no inbound anchor bundle source is wired at the IPC layer, so refetch is a
        // local no-op (returns the locally-served bundle, or null when ungoverned). The over-the-wire
        // peer fetch is the federation runtime's job; here we surface "no_bundle" rather than fabricate.
        // `Promise.try`, not `Promise.resolve(servePolicy(...))`: a failing store read must still
        // REJECT, as it did from an `async` arrow, rather than throw synchronously.
        fetch: () => Promise.try(() => servePolicy(policyStore)),
      }),
    signPolicy: async ({ toml }) => {
      const { privkeyB64, pubkeyB64 } = await ensureAnchorKeypair(vault);
      const r = authorPolicy(
        { store: policyStore, gate: policyGate, db, privkeyB64, pubkeyB64, nowMs: Date.now() },
        toml,
      );
      if (!r.ok) throw new Error(r.error);
      return { org: r.org, version: r.version };
    },
    purge: ({ externalId }) =>
      startPurge(
        {
          store: purgeJobStore,
          resolvePeer: (extId) => identityBoot?.store.activePeerIdsFor(extId)[0],
          // Grant revocation is the confirmed local effect of a purge; performed once in
          // deleteLocalContributions (which returns the count). No separate item-level
          // deletion accessor exists yet, so revokeAllGrants is a no-op to avoid double-sweeping.
          revokeAllGrants: () => {},
          deleteLocalContributions: (peerId) =>
            purgeNamespaceStore.revokeAllForPeer(peerId, Date.now()),
          knownPeers: () => localIndex.listLanPeers().map((p) => p.peer_id),
          newJobId: () => {
            purgeJobCounter += 1;
            return `gdpr-${Date.now()}-${purgeJobCounter}`;
          },
          nowMs: () => Date.now(),
        },
        externalId,
      ),
    // Local IPC socket is operator/owner-trusted (see ipc/server): treat local calls as the anchor.
    isAnchor: true,
  };
}
