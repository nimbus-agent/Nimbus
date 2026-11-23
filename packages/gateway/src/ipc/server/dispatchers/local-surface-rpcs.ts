import pino from "pino";
import { asRecord } from "../../../connectors/unknown-record.ts";
import { NULL_EGRESS_SINK } from "../../../egress/egress-ledger.ts";
import { bindConsentChannel, NO_POLICY_OVERLAY, ToolExecutor } from "../../../engine/executor.ts";
import type { ConnectorDispatcher } from "../../../engine/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../index/local-index.ts";
import { processListeners } from "../../../locality/listener-registry.ts";
import { activePackSuggestedConnectors } from "../../../packs/pack-install.ts";
import { GATEWAY_VERSION } from "../../../version.ts";
import { CatalogRpcError, dispatchCatalogRpc } from "../../catalog-rpc.ts";
import { dispatchChatopsRpc } from "../../chatops-rpc.ts";
import { DataRpcError, dispatchDataRpc } from "../../data-rpc.ts";
import { DemoRpcError, dispatchDemoRpc } from "../../demo-rpc.ts";
import { dispatchFilesystemRpc, FilesystemRpcError } from "../../filesystem-rpc.ts";
import {
  dispatchIndexDemoSymbolRpc,
  IndexDemoSymbolRpcError,
} from "../../index-demo-symbol-rpc.ts";
import { dispatchIndexRegraphRpc, IndexRegraphRpcError } from "../../index-regraph-rpc.ts";
import { generatePairingCode } from "../../lan-pairing.ts";
import { dispatchLocalityRpc, LocalityRpcError } from "../../locality-rpc.ts";
import { dispatchPolicyRpc, PolicyRpcError } from "../../policy-rpc.ts";
import { dispatchProfileRpc, ProfileRpcError } from "../../profile-rpc.ts";
import { dispatchTourRpc, TourRpcError } from "../../tour-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";

export async function tryDispatchIndexDemoSymbolRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method !== "index.demoSymbol") {
    return phase4RpcSkipped;
  }
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "index.demoSymbol requires LocalIndex");
  }
  try {
    const out = await dispatchIndexDemoSymbolRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IndexDemoSymbolRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `tour.plan` — `nimbus wow`'s guided tour of the real local index. LAN-forbidden (I5) and absent
 * from the Tauri allowlist (I7): it is a CLI onboarding affordance, matching `index.demoSymbol`.
 */
export async function tryDispatchTourRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method !== "tour.plan") {
    return phase4RpcSkipped;
  }
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "tour.plan requires LocalIndex");
  }
  try {
    const out = await dispatchTourRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      configDir: ctx.options.configDir,
      demo: ctx.options.demo === true,
      nowMs: () => Date.now(),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof TourRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `locality.report` — `nimbus wow`'s locality panel: which listeners are open right now, a
 * per-service inventory of the local index, and the index's real on-disk size. CLI-only: LAN-
 * forbidden (I5, `ipc/lan-rpc.ts`) and absent from the Tauri allowlist (I7), matching `tour.plan`.
 * The only site that touches `processListeners`/`Date.now()` — `buildLocalityReport` itself stays
 * pure over injected deps.
 */
export async function tryDispatchLocalityRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method !== "locality.report") {
    return phase4RpcSkipped;
  }
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "locality.report requires LocalIndex");
  }
  try {
    const out = await dispatchLocalityRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      dbPath: ctx.options.dbPath,
      registry: processListeners,
      nowMs: Date.now(),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof LocalityRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * `catalog.list` — the agent + connector catalog (`nimbus catalog`). Presentation only: nothing
 * reads the result to gate a call. CLI-callable today, LAN-forbidden (I5, `ipc/lan-rpc.ts`), and
 * not on the Tauri allowlist (I7) until the desktop adopts it.
 */
export function tryDispatchCatalogRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  // Synchronous work, but a Promise like every other dispatcher: `Promise.try` turns each throw
  // below into a rejection, exactly as the `async` form did.
  return Promise.try(() => {
    if (method !== "catalog.list") {
      return phase4RpcSkipped;
    }
    if (ctx.options.localIndex === undefined) {
      throw new RpcMethodError(-32603, "catalog.list requires LocalIndex");
    }
    if (ctx.options.configDir === undefined) {
      throw new RpcMethodError(-32603, "catalog.list requires configDir");
    }
    try {
      const configDir = ctx.options.configDir;
      const packStore = ctx.options.packLayerStore;
      const out = dispatchCatalogRpc(method, params, {
        db: ctx.options.localIndex.getDatabase(),
        configDir,
        ...(packStore === undefined
          ? {}
          : {
              packSuggestions: () => activePackSuggestedConnectors({ store: packStore, configDir }),
            }),
      });
      if (out.kind === "hit") return out.value;
    } catch (e) {
      if (e instanceof CatalogRpcError) {
        throw new RpcMethodError(e.rpcCode, e.message);
      }
      throw e;
    }
    return phase4RpcSkipped;
  });
}

/**
 * `demo.*` — I41 clause (5). Claimed ONLY by a demo-rooted gateway: on a normal gateway the
 * namespace is left unclaimed and the request falls through to `Method not found`, so the seeding
 * code path is not reachable at all rather than refused at runtime.
 */
export async function tryDispatchDemoRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("demo.")) return phase4RpcSkipped;
  const { demo, localIndex, configDir, dataDir } = ctx.options;
  if (
    demo !== true ||
    localIndex === undefined ||
    configDir === undefined ||
    dataDir === undefined
  ) {
    return phase4RpcSkipped;
  }
  try {
    const oncallPush = ctx.options.oncallPushRpcCtx?.runtime;
    const out = await dispatchDemoRpc(method, params, {
      db: localIndex.getDatabase(),
      configDir,
      dataDir,
      ...(oncallPush === undefined ? {} : { oncallPush }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof DemoRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchIndexRegraphRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method !== "index.regraph") {
    return phase4RpcSkipped;
  }
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "index.regraph requires LocalIndex");
  }
  try {
    const out = await dispatchIndexRegraphRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      ...(ctx.options.configDir === undefined ? {} : { configDir: ctx.options.configDir }),
      logger: pino({ level: "info" }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof IndexRegraphRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchFilesystemRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("filesystem.")) return phase4RpcSkipped;
  if (ctx.options.configDir === undefined) {
    throw new RpcMethodError(-32603, "configDir is required for filesystem.* RPCs");
  }
  try {
    const out = await dispatchFilesystemRpc(method, params, {
      configDir: ctx.options.configDir,
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof FilesystemRpcError) {
      throw new RpcMethodError(e.rpcCode, e.message);
    }
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchProfileRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("profile.")) return phase4RpcSkipped;
  if (ctx.options.profileManager === undefined) {
    throw new RpcMethodError(-32603, "Profile manager is not available on this gateway");
  }
  try {
    const out = await dispatchProfileRpc(method, params, {
      manager: ctx.options.profileManager,
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof ProfileRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * The platform `data.*` records (`data.export` stamps it into the bundle manifest): the host's own
 * when it is one of the three Nimbus supports, else `"linux"`. A pure function of its argument so
 * every arm is provable on any OS — read from `process.platform` inline, only the arm of whichever
 * OS ran the suite was ever reachable, and the coverage run is Linux-only.
 */
export function dataRpcPlatform(hostPlatform: NodeJS.Platform): "win32" | "darwin" | "linux" {
  if (hostPlatform === "win32") return "win32";
  if (hostPlatform === "darwin") return "darwin";
  return "linux";
}

export async function tryDispatchDataRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("data.")) return phase4RpcSkipped;
  try {
    const rpcPlatform = dataRpcPlatform(process.platform);
    const stubDispatcher: ConnectorDispatcher = {
      dispatch(): Promise<unknown> {
        return Promise.reject(new Error("IPC-native gate does not dispatch to MCP"));
      },
    };
    // I29: gate-only executor — local mutation, no connector dispatch, so no egress to ledger.
    const toolExecutor =
      ctx.options.localIndex === undefined
        ? undefined
        : new ToolExecutor(
            bindConsentChannel(ctx.consentImpl, clientId),
            ctx.options.localIndex,
            stubDispatcher,
            undefined,
            NULL_EGRESS_SINK,
            ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
          );
    const out = await dispatchDataRpc(method, params, {
      index: ctx.options.localIndex,
      vault: ctx.options.vault,
      platform: rpcPlatform,
      nimbusVersion: ctx.options.version ?? GATEWAY_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ...(toolExecutor === undefined ? {} : { toolExecutor }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof DataRpcError) throw new RpcMethodError(e.rpcCode, e.message, e.rpcData);
    throw e;
  }
  return phase4RpcSkipped;
}

function requireLanIndex(ctx: ServerCtx) {
  if (ctx.options.localIndex === undefined)
    throw new RpcMethodError(-32603, "Local index is not available");
  return ctx.options.localIndex;
}

function requireLanPairingWindow(ctx: ServerCtx) {
  if (ctx.options.lanPairingWindow === undefined)
    throw new RpcMethodError(-32603, "LAN pairing window not configured");
  return ctx.options.lanPairingWindow;
}

function extractPeerId(rec: Record<string, unknown> | undefined): string {
  const peerId = rec !== undefined && typeof rec["peerId"] === "string" ? rec["peerId"] : "";
  if (!peerId) throw new RpcMethodError(-32602, "Missing peerId");
  return peerId;
}

function handleLanLocalRpc(ctx: ServerCtx, method: string, params: unknown): unknown {
  const rec = asRecord(params);
  switch (method) {
    case "lan.openPairingWindow": {
      const pw = requireLanPairingWindow(ctx);
      const pairingCode = generatePairingCode();
      pw.open(pairingCode);
      const expiresAt = pw.getExpiresAt() ?? Date.now();
      return { pairingCode, expiresAt };
    }
    case "lan.closePairingWindow": {
      requireLanPairingWindow(ctx).close();
      return { ok: true };
    }
    case "lan.listPeers": {
      return { peers: requireLanIndex(ctx).listLanPeers() };
    }
    case "lan.grantWrite": {
      requireLanIndex(ctx).grantLanWrite(extractPeerId(rec));
      return { ok: true };
    }
    case "lan.revokeWrite": {
      requireLanIndex(ctx).revokeLanWrite(extractPeerId(rec));
      return { ok: true };
    }
    case "lan.removePeer": {
      requireLanIndex(ctx).removeLanPeer(extractPeerId(rec));
      return { ok: true };
    }
    case "lan.getStatus": {
      const pw = ctx.options.lanPairingWindow;
      // FS2: each peer's recorded protocol (`lan_peers.proto_version`), never its key. A peer still at
      // 1 talks the old static-box wire until it completes one v2 session or is re-paired.
      const peers = (ctx.options.localIndex?.listLanPeers() ?? []).map((row) => ({
        peerId: row.peer_id,
        direction: row.direction,
        protoVersion: row.proto_version === 2 ? 2 : 1,
      }));
      return {
        enabled: ctx.options.lanServer !== undefined,
        pairingOpen: pw?.isOpen() ?? false,
        listenAddr: ctx.options.lanServer?.listenAddr() ?? null,
        minProtocol: ctx.options.localIndex?.lanMinProtocol() ?? 1,
        peers,
        peersByProtocol: {
          v1: peers.filter((p) => p.protoVersion === 1).length,
          v2: peers.filter((p) => p.protoVersion === 2).length,
        },
      };
    }
    default:
      throw new RpcMethodError(-32601, `Method not found: ${method}`);
  }
}

export function tryDispatchLanRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("lan.")) return Promise.resolve(phase4RpcSkipped);
  // `handleLanLocalRpc` is synchronous; `Promise.try` keeps the dispatcher-table contract, so its
  // `RpcMethodError` still arrives as a rejection.
  return Promise.try(() => handleLanLocalRpc(ctx, method, params));
}

export async function tryDispatchPolicyRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  // policy.* + the team.purge GDPR entrypoint share one dependency seam.
  if (!method.startsWith("policy.") && method !== "team.purge") return phase4RpcSkipped;
  if (ctx.options.policyRpcCtx === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchPolicyRpc(method, params, ctx.options.policyRpcCtx);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof PolicyRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchChatopsRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("chatops.")) return phase4RpcSkipped;
  if (ctx.options.chatopsRpcCtx === undefined) return phase4RpcSkipped;
  const out = await dispatchChatopsRpc(method, params, ctx.options.chatopsRpcCtx);
  if (out.kind === "hit") return out.value;
  return phase4RpcSkipped;
}
