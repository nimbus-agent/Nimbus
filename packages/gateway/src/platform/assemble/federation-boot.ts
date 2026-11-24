import type { Database } from "bun:sqlite";
import os from "node:os";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  type loadNimbusFederationFromConfigDir,
  loadNimbusLanFromConfigDir,
  loadNimbusPreflightFromConfigDir,
} from "../../config/nimbus-toml.ts";
import {
  type CONNECTOR_VAULT_SECRET_KEYS,
  requiredSecretKeysFor as manifestRequiredSecretKeysFor,
  TEAM_SECRET_ANYOF_GROUPS,
} from "../../connectors/connector-secrets-manifest.ts";
import { appendAuditEntry } from "../../db/audit-chain.ts";
import { delegatedApprovalBroker } from "../../engine/delegated-approval-broker.ts";
import { buildDelegatedRequestRemote } from "../../engine/delegated-request-remote.ts";
import { DelegationStore } from "../../engine/delegation-store.ts";
import type { ExecutorDelegationDep } from "../../engine/executor.ts";
import { quorumCoordinator } from "../../engine/quorum/quorum-singleton.ts";
import { federationConsent } from "../../federation/consent-broker.ts";
import { loadOrCreateFederationIdentity } from "../../federation/federation-identity.ts";
import { buildFederationRuntime } from "../../federation/federation-runtime.ts";
import { buildFederationLanServer } from "../../federation/federation-server.ts";
import { FreeBusyLimiter } from "../../federation/free-busy-limiter.ts";
import { lanLinkFor } from "../../federation/lan-link.ts";
import { NamespaceStore } from "../../federation/namespace-store.ts";
import { preflightConsent } from "../../federation/preflight-consent-broker.ts";
import { appendPreflightAudit, defaultRunCommand } from "../../federation/preflight-gate.ts";
import { scheduleConsent } from "../../federation/schedule-consent-broker.ts";
import type { buildIdentityBoot } from "../../identity/identity-boot.ts";
import { isOperatorValid } from "../../identity/verifier.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import { sendFederatedOverWire } from "../../ipc/lan-client.ts";
import { ensureAnchorKeypair } from "../../policy/anchor-keypair.ts";
import type { PolicyGate } from "../../policy/policy-gate.ts";
import { resolveQuorumRule } from "../../policy/quorum-override.ts";
import { shareConsent } from "../../share/share-consent-broker.ts";
import type { ShareFile } from "../../share/share-format.ts";
import {
  drainPending,
  insertPendingForward,
  insertReceivedShare,
  markDelivered,
} from "../../share/share-inbox-store.ts";
import { ensureShareKeypair } from "../../share/share-keypair.ts";
import type { ShareRecord } from "../../share/share-store.ts";
import { getShareRecord } from "../../share/share-store.ts";
import { invokeTeamTool } from "../../teamvault/team-tool-invoke.ts";
import { spawnTeamToolAndCall } from "../../teamvault/team-tool-spawn.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { GATEWAY_VERSION } from "../../version.ts";
import type { PlatformPaths } from "../paths.ts";
import { oldWireNotices } from "./lan-old-wire-notice.ts";

export function asBroadcastParams(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

/** Actionable local-operator sync error (Wave 7b). The localOperator path may surface a distinct,
 *  actionable message (no cross-principal leak on the operator's own machine) — the peer path stays
 *  opaque. The login verb is verified: `nimbus identity login` (cli/src/commands/identity.ts). */
export function teamListErrorMessage(
  error: "no_grant" | "identity_invalid",
  req: { entry: string; service: string },
): string {
  if (error === "identity_invalid") {
    return `team-credential sync for ${req.service} blocked: your identity is invalid/expired — re-run the device-code login with: nimbus identity login`;
  }
  return `team-credential sync for ${req.service} failed: team-vault entry "${req.entry}" not found or service mismatch. Add it with: nimbus team vault put ${req.entry} ${req.service} --secret <key>=<value>`;
}

interface BootFederationOpts {
  federationCfg: ReturnType<typeof loadNimbusFederationFromConfigDir>;
  paths: PlatformPaths;
  vault: NimbusVault;
  db: Database;
  localIndex: LocalIndex;
  ipcOpts: Parameters<typeof createIpcServer>[0];
  sidecarStops: Array<() => void>;
  policyGate: PolicyGate;
  /** I22: the policy gate's per-call connector allowlist, from `bootPolicyGateWithConnectorAllowlist`. */
  isConnectorAllowed: (serviceId: string) => boolean;
  // I18 — operator validity for answers served OVER THE WIRE. `identityBoot` happens AFTER this
  // function runs (bootFederationIntoIpcOpts at ~2434, bootIdentityIntoIpcOpts at ~2497), so the
  // guard has to be late-bound through the holder rather than captured, exactly as
  // `buildTeamCredentialContexts` already does for the team-credential contexts.
  identityEnabled: boolean;
  identityBootRefHolder: { current: ReturnType<typeof buildIdentityBoot> | undefined };
}

/** Boot the federation LAN server + discovery into ipcOpts when enabled. Returns true if booted
 *  (so the caller can wire the consent broadcast after the IPC server exists). */
export async function bootFederationIntoIpcOpts(
  opts: BootFederationOpts,
): Promise<ExecutorDelegationDep | undefined> {
  const {
    federationCfg,
    paths,
    vault,
    db,
    localIndex,
    ipcOpts,
    sidecarStops,
    policyGate,
    isConnectorAllowed,
    identityEnabled,
    identityBootRefHolder,
  } = opts;
  if (!federationCfg.enabled) return undefined;
  const identity = await loadOrCreateFederationIdentity(vault);

  // 8d: deliver a signed share to a peer over the authenticated, pubkey-pinned federation wire.
  const deliverShareToPeer = async (
    share: ShareFile,
    peer: { host: string; port: number; pubkey: string },
  ): Promise<void> => {
    const pubkey = new Uint8Array(Buffer.from(peer.pubkey, "base64"));
    // The row is read fresh: the link policy needs the peer's CURRENT recorded protocol (the ratchet).
    const row = localIndex.getLanPeerByPubkey(pubkey);
    if (row === undefined) throw new Error("share forward: recipient is no longer a paired peer");
    await sendFederatedOverWire(
      peer.host,
      peer.port,
      identity,
      pubkey,
      "federation.shareReceive",
      { share },
      undefined,
      lanLinkFor(row, localIndex),
    );
  };
  // peerId/pubkey → reachable ForwardPeer (paired only, host+port must be present).
  const lookupForwardPeer = (
    recipientPubkey: string,
  ): { host: string; port: number; pubkey: string } | undefined => {
    const row = localIndex.getLanPeerByPubkey(
      new Uint8Array(Buffer.from(recipientPubkey, "base64")),
    );
    if (row?.host_ip == null || row.host_port == null) return undefined;
    return { host: row.host_ip, port: row.host_port, pubkey: recipientPubkey };
  };
  // Resolve a `peer:<hex>` id to its paired row's b64 pubkey. For a raw input, pass it through ONLY
  // if it is a structurally-valid 32-byte Ed25519/X25519 pubkey (a cryptographic recipient identity,
  // for the deferred-reveal queue — §9.4); any other unknown/garbage value resolves to `undefined`
  // so the RPC rejects it (no caller-supplied arbitrary destination; no undrainable pending rows).
  const resolvePeerPubkeyFn = (peerIdOrPubkey: string): string | undefined => {
    const row = localIndex
      .listLanPeers()
      .find(
        (r) =>
          `peer:${bytesToHex(new Uint8Array(r.peer_pubkey).subarray(0, 8))}` === peerIdOrPubkey,
      );
    if (row !== undefined) return Buffer.from(new Uint8Array(row.peer_pubkey)).toString("base64");
    // Not a known peer id → accept only a canonical 32-byte base64 pubkey.
    try {
      const decoded = Buffer.from(peerIdOrPubkey, "base64");
      if (decoded.length === 32 && decoded.toString("base64") === peerIdOrPubkey) {
        return peerIdOrPubkey;
      }
    } catch {
      /* fall through to undefined */
    }
    return undefined;
  };
  // Reconstruct a ShareFile from a share_records row (camelCase mapped fields from share-store.ts).
  const shareFileFromRecord = (r: ShareRecord): ShareFile => ({
    format: "nimbus-share/v1",
    contentHash: r.contentHash,
    body: JSON.parse(r.bodyJson) as ShareFile["body"],
    sig: JSON.parse(r.sigJson) as ShareFile["sig"],
    forwarding: r.provenance as ShareFile["forwarding"],
  });

  // drain-on-pair: when a new peer pairs, flush any pending forwards queued for them.
  const drainOnPair = async (peerId: string): Promise<void> => {
    const pub = resolvePeerPubkeyFn(peerId);
    if (pub === undefined) return;
    const peer = lookupForwardPeer(pub);
    if (peer === undefined) return;
    for (const row of drainPending(db, pub)) {
      try {
        await deliverShareToPeer(row.share, peer); // NOSONAR S9382: FIFO drain - the peer receives its queued forwards one at a time in received_at order, over an unbounded queue
        markDelivered(db, row.id);
      } catch {
        /* best-effort; retried on next pair/online event */
      }
    }
  };

  const federationRuntime = buildFederationRuntime(
    federationCfg,
    localIndex,
    identity,
    drainOnPair,
  );
  if (federationRuntime === undefined) return undefined;
  void federationRuntime.discovery.start();
  sidecarStops.push(() => void federationRuntime.discovery.stop());
  ipcOpts.federationDiscovery = federationRuntime.discovery;
  ipcOpts.federationPairing = federationRuntime.pairing;
  ipcOpts.federationConsentTimeoutSeconds = federationRuntime.consentTimeoutSeconds;
  ipcOpts.federationIdentity = identity;

  const lanCfg = loadNimbusLanFromConfigDir(paths.configDir);
  // The old v1 wire is gone (FS3): tell the owner once if the config still asks for it, and tell
  // them which address to upgrade when such a peer knocks (at most once an hour per address).
  const oldWire = oldWireNotices(paths.logDir, lanCfg.minProtocolIgnored);
  // Team Vault (Slice 2): the anchor's invoke backing. quorumFor resolves the authoritative quorum
  // rule via EnforcedPolicy (Task 9) — max(local [hitl.quorum] baseline, org policy); ungoverned it
  // returns the local baseline verbatim, governed it tightens. runTool resolves the team secret
  // (teamvault.<entry>.*) and runs the tool in an ephemeral team-credentialed connector
  // (I19 — secret stays in the subprocess env, never returned).
  const teamVault = {
    quorumFor: (toolId: string) => resolveQuorumRule(policyGate.enforced(), toolId),
    runTool: (input: { entry: string; service: string; toolId: string; args: unknown }) =>
      invokeTeamTool(
        {
          vault,
          sandboxCwd: paths.sandboxDir,
          requiredSecretKeysFor: manifestRequiredSecretKeysFor,
          anyOfSecretGroupsFor: (service: string) =>
            TEAM_SECRET_ANYOF_GROUPS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
          spawnAndCall: spawnTeamToolAndCall,
        },
        input,
      ),
    // I22: the invoke gate refuses an invoke when the org policy blocks the entry's connector or
    // the server the requested key belongs to.
    isConnectorAllowed,
  };
  ipcOpts.teamVault = teamVault;
  // Delegated HITL (Slice 2, I20). As a DELEGATE, this gateway answers an owner's routed approval by
  // prompting its own local clients via the delegated-approval broker (CLI/UI `team approve` →
  // federation.approvalRespond resolves it). As an OWNER, the executor gate routes a HITL action to
  // an active delegate over the wire (delegationDep, threaded into run-ask).
  const delegationStore = new DelegationStore(db);
  const delegationDep: ExecutorDelegationDep = {
    store: delegationStore,
    isOperatorValid: () => true,
    requestRemote: buildDelegatedRequestRemote({
      store: delegationStore,
      index: localIndex,
      selfIdentity: identity,
    }),
  };
  // GDPR purge signer (Slice 4, spec D11). Resolve the Ed25519 anchor keypair once (Vault-only seed)
  // and pass the privkey seed + this gateway's federation selfPeerId so an approved federation.purge
  // can return a valid signed DeletionRecord. selfPeerId is derived from the federation box identity's
  // public key the same way peers are identified (peer:<first-8-bytes-hex>).
  // deletePurgeContributions (Task 26): after the LOCAL operator approves an inbound federation.purge,
  // delete the requesting peer's local contributions. The confirmed local effect is revoking ALL of
  // that peer's federation grants (NamespaceStore.revokeAllForPeer); its count is the deletedCount in
  // the signed receipt. Item-level row deletion has no confirmed accessor — see Task 26 report.
  const { privkeyB64: purgePrivkeyB64 } = await ensureAnchorKeypair(vault); // gitleaks:allow — Vault-resolved seed, not a literal
  const selfPeerId = `peer:${bytesToHex(identity.publicKey.subarray(0, 8))}`;
  const purgeNamespaceStore = new NamespaceStore(db);
  const built = buildFederationLanServer({
    db,
    index: localIndex,
    identity,
    purgeSign: { privkeyB64: purgePrivkeyB64, selfPeerId },
    deletePurgeContributions: (_externalId, peerId) =>
      purgeNamespaceStore.revokeAllForPeer(peerId, Date.now()),
    lan: {
      bind: lanCfg.bind,
      port: lanCfg.port,
      pairingWindowSeconds: lanCfg.pairingWindowSeconds,
      maxFailedAttempts: lanCfg.maxFailedAttempts,
      lockoutSeconds: lanCfg.lockoutSeconds,
      onOldWireRefused: oldWire.refused,
    },
    // I18 — the operator-validity guard for answers served OVER THE WIRE.
    //
    // Every federated gate already reads it (`gate-commons.ts`, `invoke-gate.ts`,
    // `preflight-gate.ts` all test `ctx.identity?.enabled === true && !ctx.identity.isOperatorValid()`),
    // and `ipc/server/dispatchers.ts` has always supplied it — but only on the LOCAL IPC path, i.e.
    // the owner querying their own machine, the one case where it is not needed. This 14-key object
    // literal did not include it, so `ctx.identity` was `undefined` for every peer-facing answer,
    // `undefined?.enabled === true` was false, and the branch never executed: a gateway whose
    // operator SSO session had been deprovisioned or expired past grace kept answering
    // `federation.query` / `auditExport` / `invoke` / `preflight` instead of failing closed.
    //
    // Late-bound, not captured: identity boots AFTER federation (see BootFederationOpts), so the
    // holder is read per call and fails closed until it is populated — the same shape
    // `buildTeamCredentialContexts` uses for exactly this ordering problem.
    ...(identityEnabled
      ? {
          identityGuard: {
            enabled: true,
            isOperatorValid: (): boolean => {
              const ref = identityBootRefHolder.current;
              const store = ref?.store;
              const issuer = ref?.issuer;
              if (store === undefined || issuer === undefined) return false; // unbooted → invalid
              return isOperatorValid(store, issuer, Date.now(), ref?.graceSeconds ?? 0);
            },
          },
        }
      : {}),
    consentTimeoutMs: federationRuntime.consentTimeoutSeconds * 1000,
    notify: () => {},
    discovery: federationRuntime.discovery,
    pairing: federationRuntime.pairing,
    teamVault,
    delegateApproval: async ({ actionType }) => {
      const r = await delegatedApprovalBroker.request(
        { prompt: `Approve delegated action: ${actionType}?` },
        federationRuntime.consentTimeoutSeconds * 1000,
      );
      return r.kind === "answered" ? r.approved : false;
    },
    // I24 (Slice 6b): serve inbound preflights over the wire behind THIS owner's local HITL approval;
    // the command is resolved from local nimbus.toml only, never from the caller.
    preflight: {
      isPeerGranted: (ns, peerId) =>
        new NamespaceStore(db).getActiveGrant(ns, peerId) !== undefined,
      resolveCommand: (ns) => loadNimbusPreflightFromConfigDir(paths.configDir).get(ns),
      requestApproval: (input) =>
        preflightConsent.request(input, federationRuntime.consentTimeoutSeconds * 1000 + 5000),
      runCommand: defaultRunCommand,
      audit: (e) => appendPreflightAudit(db, e),
    },
    // I17 (b) (OR-S4-SCHED): answer a peer's free/busy request, but only after THIS owner approves it.
    freeBusy: {
      db,
      limiter: new FreeBusyLimiter(),
      requestApproval: (input) =>
        scheduleConsent.request(input, federationRuntime.consentTimeoutSeconds * 1000 + 5000),
    },
    // 8d: receive forwarded shares inert (spec §9.4) — store in share_inbox, no HITL.
    receiveShareDeps: {
      now: () => Date.now(),
      storeReceived: (share) => insertReceivedShare(db, { share, now: Date.now() }),
    },
  });
  // Register the stop callback BEFORE start() so a throw from start() can't leak the server.
  sidecarStops.push(() => void built.lanServer.stop());
  await built.lanServer.start();
  const addr = built.lanServer.listenAddr();
  if (addr !== undefined && federationCfg.mdnsEnabled) {
    void federationRuntime.discovery.advertise(`nimbus-${GATEWAY_VERSION}`, addr.port);
  }
  ipcOpts.lanServer = built.lanServer;
  ipcOpts.lanPairingWindow = built.pairingWindow;

  // 8d: wire forward/resolve deps into the local IPC federation dispatch path.
  // forwardShareDeps — the second I27 chokepoint's dependencies (owner calls federation.shareForward).
  ipcOpts.federationForwardShareDeps = {
    now: () => Date.now(),
    label: os.hostname(),
    loadShare: (h) => {
      const r = getShareRecord(db, h);
      return r === undefined ? undefined : shareFileFromRecord(r);
    },
    shareKeypair: () => ensureShareKeypair(vault),
    // SAME owner consent broker as createShare (D21 extension: second outbound-share chokepoint).
    requestApproval: (preview, redactionSet) =>
      shareConsent.request(
        { sessionId: "", kind: "forward", preview, redactionSet, sink: "peer" },
        (ipcOpts.federationConsentTimeoutSeconds ?? 30) * 1000 + 5000,
      ),
    lookupPeer: lookupForwardPeer,
    deliver: deliverShareToPeer,
    queuePending: (recipientPubkey, share) =>
      insertPendingForward(db, { recipientPubkey, share, now: Date.now() }),
    recordAudit: (entry) => appendAuditEntry(db, entry),
  };
  ipcOpts.federationResolvePeerPubkey = resolvePeerPubkeyFn;
  // 8d origin emit (share.create --to-peer): deliver the already-approved+signed share to a peer.
  // No hop is appended here (origin, hops stays 0) — createShare already ran the share.publish HITL.
  ipcOpts.shareDeliverToPeer = async (share: ShareFile, peerId: string): Promise<boolean> => {
    const pub = resolvePeerPubkeyFn(peerId);
    if (pub === undefined) return false;
    const peer = lookupForwardPeer(pub);
    if (peer === undefined) return false;
    // A transport failure must not fail `share.create --to-peer` — the share is already persisted
    // locally (createShare ran first); report delivered:false rather than throwing.
    try {
      await deliverShareToPeer(share, peer);
      return true;
    } catch {
      return false;
    }
  };

  return delegationDep;
}

export type IpcBroadcaster = Pick<ReturnType<typeof createIpcServer>, "broadcast">;

/**
 * Federation's prompts reach the local owner and approvers through the live IPC broadcast; only
 * when federation booted (`bootFederationIntoIpcOpts` returned its delegation dep).
 */
export function bindFederationBroadcasts(
  ipc: IpcBroadcaster,
  federationBooted: ExecutorDelegationDep | undefined,
): void {
  if (federationBooted === undefined) return;
  federationConsent.setBroadcast((method, params) =>
    ipc.broadcast(method, asBroadcastParams(params)),
  );
  // I24 (Slice 6b): the inbound-preflight approval prompt reaches the local owner via the same
  // broadcast channel; they answer with `nimbus preflight approve <id>` → federation.preflightRespond.
  preflightConsent.setBroadcast((method, params) =>
    ipc.broadcast(method, asBroadcastParams(params)),
  );
  // I17 (b): the inbound free/busy approval prompt reaches the owner's terminal the same way; they
  // answer in `nimbus team listen` (or `nimbus team schedule-consent`), which calls scheduling.respond.
  scheduleConsent.setBroadcast((method, params) =>
    ipc.broadcast(method, asBroadcastParams(params)),
  );
  // Quorum (I21) + delegated-approval (I20) requests reach subscribers (local owner UI / approver
  // poll) via the same broadcast channel as consent; remote responders answer over the wire
  // through federation.quorumRespond / federation.approvalRespond.
  quorumCoordinator.setBroadcast((requestId) =>
    ipc.broadcast("federation.quorumRequest", { requestId }),
  );
  delegatedApprovalBroker.setBroadcast((requestId, prompt) =>
    ipc.broadcast("federation.approvalRequest", { requestId, prompt }),
  );
}
