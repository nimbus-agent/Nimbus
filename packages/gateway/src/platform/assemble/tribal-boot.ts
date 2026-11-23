import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { ChatopsBoot } from "../../chatops/chatops-boot.ts";
import { buildE2eSinkDispatcher } from "../../chatops/chatops-tool-runner-e2e-sink.ts";
import type { ChatMessage, ReplyTarget } from "../../chatops/types.ts";
import type { NimbusChatopsToml, NimbusTribalToml } from "../../config/nimbus-toml.ts";
import type { TribalKbConfig } from "../../connectors/connector-writes/model-write-refusals.ts";
import { createConnectorDispatcher, meshDispatcherClient } from "../../connectors/index.ts";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/index.ts";
import { makeEgressSink } from "../../egress/egress-ledger.ts";
import { embedQueryBestEffort } from "../../embedding/embedding-readiness.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../../engine/executor.ts";
import type { ConnectorDispatcher } from "../../engine/types.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import { extractKbPageRef } from "../../ipc/server/dispatchers.ts";
import type { TribalSubmitAction } from "../../ipc/tribal-rpc.ts";
import { vectorSearchChunks } from "../../search/vec-store.ts";
import { type SynthSource, synthesizeAnswer } from "../../tribal/answer-synthesizer.ts";
import type { TribalCluster } from "../../tribal/cluster-store.ts";
import { buildTribalBoot, type TribalBoot } from "../../tribal/tribal-boot.ts";
import {
  handleTribalCaptureCommand,
  parseTribalCaptureCommand,
} from "../../tribal/tribal-chat-capture.ts";
import { processEnvGet } from "../env-access.ts";
import type { EmbeddingRuntime } from "./index-boot.ts";

/**
 * The `[tribal]` knowledge-base destinations for the model connector-write door's KB refusal
 * (Phase 9.7 B, F4), from the loaded config whether or not `[tribal].enabled`: a configured KB is
 * the capture gate's destination either way. `undefined` when neither is configured.
 */
export function tribalKbConfigOf(
  cfg: NimbusTribalToml,
  unreadable = false,
): TribalKbConfig | undefined {
  // An UNREADABLE `[tribal]` section is not an absent one: its defaults name no destination, so
  // every KB-capable write must be refused (fail closed), not allowed as "no KB configured".
  if (unreadable) return { unreadable: true };
  if (cfg.notion === undefined && cfg.confluence === undefined) return undefined;
  return {
    ...(cfg.notion === undefined ? {} : { notion: { databaseId: cfg.notion.databaseId } }),
    ...(cfg.confluence === undefined
      ? {}
      : {
          confluence: {
            spaceKey: cfg.confluence.spaceKey,
            parentPageId: cfg.confluence.parentPageId,
          },
        }),
  };
}

// Tribal-knowledge watcher boot (Phase 6 Slice 6c), extracted verbatim from
// assemblePlatformServices to keep that function's cognitive complexity in budget (S3776). This is
// a BEHAVIOUR-PRESERVING extraction: boot ordering and every wiring decision are identical.
//
// The chatops↔tribal boot cycle is preserved exactly via two late-binding seams the caller owns:
//   - `sendHolder.current` — the I23 reply seam. `buildTribalBoot`'s `send` closure reads it at
//     post time; the caller rebinds it to `chatopsBoot.replyTo` AFTER chatops boots. Sharing one
//     mutable holder keeps the original late-bound `let tribalSend` semantics across the boundary.
//   - `getChatopsBoot()` — `chatopsBoot` is assigned after this function returns; the in-chat
//     capture interceptor reads it at message time (skips cleanly if chatops isn't up).
// Synchronous: building the tribal boot awaits nothing (the asynchronous work lives in the
// closures it returns), so the caller has nothing to await either.
export function bootTribalKnowledge(deps: {
  tribalCfg: NimbusTribalToml;
  chatopsCfg: NimbusChatopsToml;
  rt: EmbeddingRuntime;
  db: Database;
  syncLogger: Logger;
  localIndex: LocalIndex;
  connectorMesh: LazyConnectorMesh;
  ipcOpts: Parameters<typeof createIpcServer>[0];
  sendHolder: { current: (target: ReplyTarget, text: string) => Promise<void> };
  getChatopsBoot: () => ChatopsBoot | undefined;
}): {
  tribalBoot: TribalBoot;
  tribalInterceptCommand: (m: ChatMessage) => Promise<boolean>;
} {
  const {
    tribalCfg,
    chatopsCfg,
    rt,
    db,
    syncLogger,
    localIndex,
    connectorMesh,
    ipcOpts,
    sendHolder,
    getChatopsBoot,
  } = deps;
  // Embeddings absent is a DEGRADATION, not a security boundary: repeat detection needs the
  // embedder, so without it the watcher is inert (embedQuery → null), but the IPC surface,
  // CLI list/dismiss, and owner-HITL capture still work. The privacy fail-closed (empty
  // watch_channels) is enforced inside buildTribalBoot regardless.
  const embeddingRt = rt;
  if (embeddingRt == null) {
    syncLogger.warn(
      "[tribal].enabled but the embedding runtime is unavailable — repeat detection is inert; capture/list still work",
    );
  }
  const tribalModel = embeddingRt?.getEmbeddingModel() ?? "";
  const tribalWatch = tribalCfg.watchChannels;
  const tribalWatchSet = new Set(tribalWatch);
  // Recall the cluster's source threads from the index, channel-filtered IN SQL (review §2.1),
  // and hydrate each hit with its channel + url for citations. Empty when the cluster has no vec.
  const gatherSources = (cluster: TribalCluster): SynthSource[] => {
    const vec = cluster.representativeVec;
    if (vec === null) return [];
    const hits = [
      ...vectorSearchChunks(db, {
        queryEmbedding: vec,
        model: tribalModel,
        limit: 5,
        service: "slack",
        itemType: "message",
        metadataChannelIn: tribalWatch,
      }),
      ...vectorSearchChunks(db, {
        queryEmbedding: vec,
        model: tribalModel,
        limit: 5,
        service: "teams",
        itemType: "message",
        metadataChannelIn: tribalWatch,
      }),
    ];
    const out: SynthSource[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      if (seen.has(h.itemId)) continue;
      seen.add(h.itemId);
      const row = db.query("SELECT metadata, url FROM item WHERE id = ?").get(h.itemId) as {
        metadata: string | null;
        url: string | null;
      } | null;
      let channelId = "";
      if (row?.metadata != null) {
        try {
          const m = JSON.parse(row.metadata) as { channel?: unknown };
          if (typeof m.channel === "string") channelId = m.channel;
        } catch {
          // non-JSON metadata → leave channelId empty (filtered out by the watch-set check)
        }
      }
      out.push({ itemId: h.itemId, channelId, url: row?.url ?? null, text: h.chunkText });
    }
    return out;
  };
  // v1 synthesis: a deterministic draft (title = the question, body = the source snippets) that
  // the owner reviews + edits at the HITL gate. The injected-llm seam keeps swapping in an
  // LLM-authored prose draft a one-line change (answer-synthesizer.ts SYNTH_PROMPT is ready).
  const tribalSynthesize = (cluster: TribalCluster) =>
    synthesizeAnswer(
      {
        gatherSources,
        watchChannels: tribalWatchSet,
        llm: (question, srcs) =>
          Promise.resolve({
            title: question.slice(0, 120),
            bodyMarkdown:
              srcs.length === 0
                ? "No source context was found — please write the answer manually before saving."
                : `Drafted from ${srcs.length} source message(s) — review and edit before saving.\n\n${srcs
                    .map((s) => `- ${s.text}`)
                    .join("\n")}`,
          }),
      },
      cluster,
    );
  const tribalBoot = buildTribalBoot({
    db,
    cfg: tribalCfg,
    embedQuery: (text) =>
      // Best-effort: tribal clustering degrades to no-match while the model warms (#928).
      embeddingRt == null ? Promise.resolve(null) : embedQueryBestEffort(embeddingRt, text),
    // Bot self-filter (review §1.1): primary guard is the Slack normalizer's bot_id/subtype skip
    // (Task 8); this is defense-in-depth using the configured Teams bot app id. (The Slack bot
    // user id is not resolvable without an extra API call at boot.)
    botUserIds: new Set([chatopsCfg.teamsBotAppId].filter((s) => s !== "")),
    send: (target, text) => sendHolder.current(target, text),
    synthesize: tribalSynthesize,
    log: (m) => syncLogger.warn(m),
  });
  ipcOpts.tribalRpcCtx = tribalBoot.rpcCtx;
  // I25 capture write target: the e2e sink when set (Task 20), else the real connector mesh.
  const tribalE2eSinkDir = processEnvGet("NIMBUS_CHATOPS_E2E_SINK_DIR");
  const tribalDispatcher: ConnectorDispatcher =
    tribalE2eSinkDir === undefined || tribalE2eSinkDir === ""
      ? createConnectorDispatcher(meshDispatcherClient(connectorMesh))
      : buildE2eSinkDispatcher(tribalE2eSinkDir);
  ipcOpts.tribalConnectorDispatcher = tribalDispatcher;
  // In-chat capture trigger (Task 19): `@nimbus tribal capture <id>` → I25 write-gate with the
  // owner's chatops HITL consent. `chatopsBoot` is late-bound (assigned just below), so the
  // closure reads it at message time. Skips cleanly if chatops isn't up.
  const tribalRpcCtx = tribalBoot.rpcCtx;
  const tribalInterceptCommand = async (msg: ChatMessage): Promise<boolean> => {
    const cmd = parseTribalCaptureCommand(msg.text);
    if (cmd === undefined) return false;
    const cb = getChatopsBoot();
    if (cb === undefined) return false;
    // Only an enrolled (mapped) sender may trigger the owner-HITL capture — otherwise fall
    // through to the IntentRouter (which refuses unmapped users). Without this, any addressed
    // channel member could spam the local owner with capture approval prompts.
    if (!(await cb.isSenderMapped(msg.platform, msg.userId))) return false;
    const executor = new ToolExecutor(
      { requestApproval: (p, d) => cb.requestOwnerApproval(p, d) },
      localIndex,
      tribalDispatcher,
      undefined,
      // I29: in-chat tribal capture dispatches a real connector KB write — ledger it.
      makeEgressSink(localIndex.getDatabase()),
      // I22: same org-policy overlay the IPC executors get. Read from `ipcOpts` rather than
      // closed over, because this function is handed `ipcOpts` and nothing else policy-shaped.
      ipcOpts.policyHitl ?? NO_POLICY_OVERLAY,
    );
    const submit: TribalSubmitAction = async (action) => {
      const res = await executor.execute({ type: action.type, payload: action.payload });
      if (res.status !== "ok") return { status: "rejected" };
      return {
        status: "approved",
        result: { pageRef: extractKbPageRef(action.type, res.result) },
      };
    };
    await handleTribalCaptureCommand(
      {
        capture: (id, t) => tribalRpcCtx.capture(id, t, submit),
        reply: (text) =>
          cb.replyTo(
            { kind: "originating", platform: msg.platform, channelId: msg.channelId },
            text,
          ),
      },
      cmd,
    );
    return true;
  };
  return { tribalBoot, tribalInterceptCommand };
}
