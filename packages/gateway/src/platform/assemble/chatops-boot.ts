import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import {
  buildChatopsAgentInvoker,
  type ChatopsAgentInvoker,
} from "../../agent-runs/agent-chatops-invoke.ts";
import type { SynthesisRouter } from "../../agents/_lib/synthesis-llm.ts";
import type { WatcherChatNotifier } from "../../automation/watcher-chat-notifier.ts";
import { buildChatopsBoot, type ChatopsBoot } from "../../chatops/chatops-boot.ts";
import { buildChatopsToolRunner } from "../../chatops/chatops-tool-runner.ts";
import {
  buildE2eSinkDispatcher,
  buildE2eSinkRunChatopsTool,
} from "../../chatops/chatops-tool-runner-e2e-sink.ts";
import type { ChatMessage, ReplyTarget } from "../../chatops/types.ts";
import type { loadNimbusChatopsFromConfigDir } from "../../config/nimbus-toml.ts";
import { createConnectorWriteDispatcher } from "../../connectors/connector-write-dispatch.ts";
import type { ConnectorWriteContext } from "../../connectors/connector-write-transport.ts";
import { createConnectorDispatcher, meshDispatcherClient } from "../../connectors/index.ts";
import { appendAuditEntry } from "../../db/audit-chain.ts";
import { makeEgressSink } from "../../egress/egress-ledger.ts";
import { delegatedApprovalBroker } from "../../engine/delegated-approval-broker.ts";
import type { buildIdentityBoot } from "../../identity/identity-boot.ts";
import { buildTeamsBotJwtValidator } from "../../identity/teams-bot-jwt.ts";
import { isOperatorValid } from "../../identity/verifier.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import type { OncallPushRuntime } from "../../oncall-push/push-runtime.ts";
import type { PolicyGate } from "../../policy/policy-gate.ts";
import type { AgentLatencyRecorder } from "../../telemetry/agent-latency.ts";
import type { TribalBoot } from "../../tribal/tribal-boot.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { processEnvGet } from "../env-access.ts";
import type { PlatformPaths } from "../paths.ts";
import type { IpcBroadcaster } from "./federation-boot.ts";
import type { HttpSidecarOpts } from "./http-sidecar.ts";
import { CHATOPS_LOCAL_CONSENT_TIMEOUT_MS } from "./policy-identity-boot.ts";
import type { createSchedulerWithMesh } from "./scheduler-mesh.ts";

/** ChatOps (Phase 6 Slice 5) boot wiring. When [chatops].enabled, build the Slack/Teams bot graph
 *  and wire it into the IPC + HTTP sidecar opts; returns the live ChatopsBoot (or undefined when
 *  disabled). Extracted from assemblePlatformServices to keep its cognitive complexity in budget;
 *  the chatops↔tribal reply cycle is preserved by rebinding `tribalSendHolder.current` here. */
export async function bootChatopsIntoAssembly(deps: {
  chatopsCfg: ReturnType<typeof loadNimbusChatopsFromConfigDir>;
  policyGate: Parameters<typeof buildChatopsBoot>[0]["policyGate"] &
    Pick<PolicyGate, "status" | "governanceIntended">;
  tribalBoot: TribalBoot | undefined;
  tribalInterceptCommand: ((m: ChatMessage) => Promise<boolean>) | undefined;
  identityBoot: ReturnType<typeof buildIdentityBoot> | undefined;
  vault: NimbusVault;
  paths: PlatformPaths;
  db: Database;
  connectorMesh: Awaited<ReturnType<typeof createSchedulerWithMesh>>["connectorMesh"];
  syncLogger: Logger;
  ipcOpts: Parameters<typeof createIpcServer>[0];
  httpSidecarOpts: HttpSidecarOpts;
  sidecarStops: Array<() => void>;
  tribalSendHolder: { current: (target: ReplyTarget, text: string) => Promise<void> };
  chatopsAllowedByBootPolicy: boolean;
  /** I23 amendment: the owner's pinned watcher-notice channel, boot-time config only. */
  watcherPinnedChannel: string | undefined;
  /** The connector-write transport's context, the one `runAsk`'s dispatcher is wrapped with too. */
  connectorWriteDeps: ConnectorWriteContext;
}): Promise<ChatopsBoot | undefined> {
  const {
    chatopsCfg,
    policyGate,
    tribalBoot,
    tribalInterceptCommand,
    identityBoot,
    vault,
    paths,
    db,
    connectorMesh,
    syncLogger,
    ipcOpts,
    httpSidecarOpts,
    sidecarStops,
    tribalSendHolder,
    chatopsAllowedByBootPolicy,
    watcherPinnedChannel,
    connectorWriteDeps,
  } = deps;
  // I41: a demo gateway never boots ChatOps, whatever its config says (BootPolicy.chatops).
  if (!chatopsCfg.enabled || !chatopsAllowedByBootPolicy) return undefined;
  const identityBootRef = identityBoot;
  // E2E seam (NIMBUS_CHATOPS_E2E_SINK_DIR, precedent: NIMBUS_SKIP_EMBEDDING_RUNTIME): swap the
  // real bot-credentialed connector spawn + mesh dispatch for a file-backed mock — the "mock
  // Slack/Teams transport" the real-gateway e2e drives. Unset in production (the real spawn).
  const chatopsE2eSinkDir = processEnvGet("NIMBUS_CHATOPS_E2E_SINK_DIR");
  const chatopsBoot = await buildChatopsBoot({
    cfg: chatopsCfg,
    db,
    vault,
    policyGate,
    ...(watcherPinnedChannel === undefined
      ? {}
      : { watcherPinnedChannel, orgPolicyActive: () => policyGate.governanceIntended() }),
    ...(tribalBoot === undefined ? {} : { onInboundMessage: tribalBoot.onInboundMessage }),
    ...(tribalInterceptCommand === undefined ? {} : { interceptCommand: tribalInterceptCommand }),
    ...(identityBootRef === undefined
      ? {}
      : {
          identity: {
            findScimByEmail: (email: string) => {
              const scim = identityBootRef.store.findScimByEmail(email);
              if (scim === undefined) return undefined;
              return {
                externalId: scim.externalId,
                email: scim.email ?? email,
                active: scim.active,
                issuer: identityBootRef.issuer,
              };
            },
            isOperatorValid: (issuer: string) =>
              isOperatorValid(
                identityBootRef.store,
                issuer,
                Date.now(),
                identityBootRef.graceSeconds,
              ),
          },
        }),
    runTool:
      chatopsE2eSinkDir === undefined || chatopsE2eSinkDir === ""
        ? buildChatopsToolRunner({
            vault,
            botVaultEntry: chatopsCfg.botVaultEntry,
            sandboxCwd: paths.sandboxDir,
          })
        : buildE2eSinkRunChatopsTool(chatopsE2eSinkDir),
    audit: { recordAudit: (entry) => appendAuditEntry(db, entry) },
    // A connector write the owner approves from chat runs through the connector-write transport,
    // with the credential [connectors.<name>] configures and the I22 allowlist asked first: the
    // same wrapper and context gateway-main.ts installs around runAsk's dispatcher, and the first
    // shipped surface whose connector writes reach it. The plain mesh dispatcher found no tool for a
    // write that names no mcpToolId, and ran one that names it with the personal credential
    // whatever the config said.
    dispatcher:
      chatopsE2eSinkDir === undefined || chatopsE2eSinkDir === ""
        ? createConnectorWriteDispatcher(
            createConnectorDispatcher(meshDispatcherClient(connectorMesh)),
            connectorWriteDeps,
          )
        : buildE2eSinkDispatcher(chatopsE2eSinkDir),
    // I29: chatops-approved writes dispatch real connector actions — ledger them (append-before-dispatch).
    egressSink: makeEgressSink(db),
    ...(chatopsCfg.teamsEnabled && chatopsCfg.teamsBotAppId !== ""
      ? {
          validateTeamsJwt: buildTeamsBotJwtValidator({
            db,
            teamsBotAppId: chatopsCfg.teamsBotAppId,
            log: (m) => syncLogger.warn(m),
          }),
        }
      : {}),
    log: (m) => syncLogger.warn(m),
    // Design §13.1: an egress-ledger append failure on an outbound post must be LOUD at `error`,
    // not folded into the generic `warn` seam above.
    logError: (fields, msg) => syncLogger.error(fields, msg),
  });
  ipcOpts.chatopsRpcCtx = chatopsBoot.rpcCtx;
  const teamsSurface = chatopsBoot.teamsSurface;
  if (teamsSurface !== undefined) {
    httpSidecarOpts.resolveTeamsEventsSurface = () => Promise.resolve(teamsSurface);
  }
  const stopChatops = chatopsBoot;
  sidecarStops.push(() => void stopChatops.stop());
  // Resolve the chatops↔tribal cycle: rebind the tribal watcher's `send` (the shared holder the
  // tribal `send` closure reads at post time) to the chatops I23 reply seam now that it exists.
  // Without chatops, the holder stays the no-op (detection still records clusters; CLI capture
  // works; only auto-suggestion posts are suppressed).
  if (tribalBoot !== undefined) {
    const replyTo = chatopsBoot.replyTo;
    tribalSendHolder.current = (target, text) => replyTo(target, text);
  }
  return chatopsBoot;
}

/**
 * Design § 4 (2026-10-02-oncall-push-chatops-design.md) (boot race): the ONE place the on-call push learns whether ChatOps exists. Called right
 * after `bootChatopsIntoAssembly` on BOTH branches. Until it runs, the push runtime holds every
 * run, so a PagerDuty sync that completes during boot is delivered after this, never dropped.
 */
export function settleOncallPushChatops(
  oncallPush: Pick<OncallPushRuntime, "settleChatopsPoster" | "config">,
  chatopsBoot: Pick<ChatopsBoot, "postPushedBrief"> | undefined,
): void {
  if (chatopsBoot === undefined) {
    oncallPush.settleChatopsPoster(undefined);
    return;
  }
  const namespace = oncallPush.config.chatopsNamespace;
  oncallPush.settleChatopsPoster((text) => chatopsBoot.postPushedBrief(namespace, text));
}

/**
 * The ONE place the watcher notice learns whether ChatOps exists, and the only place its poster is
 * bound to a namespace (I23): the config namespace, never one a watcher, a row or an event names.
 * Called once, right after `settleOncallPushChatops`, on the enabled AND the disabled branch.
 * `watcherChat` is `undefined` when the feature is off or the gateway is a demo: a no-op.
 */
export function settleWatcherChatops(
  watcherChat: Pick<WatcherChatNotifier, "settle" | "destination"> | undefined,
  chatopsBoot: Pick<ChatopsBoot, "postWatcherNotice" | "postWatcherNoticePinned"> | undefined,
): void {
  if (watcherChat === undefined) return;
  if (chatopsBoot === undefined) {
    watcherChat.settle(undefined);
    return;
  }
  const dest = watcherChat.destination;
  if (dest.kind === "pinned") {
    // The channel is not here: the boot was built with it (`watcherPinnedChannel`).
    watcherChat.settle((text) => chatopsBoot.postWatcherNoticePinned(text));
    return;
  }
  const namespace = dest.namespace;
  watcherChat.settle((text) => chatopsBoot.postWatcherNotice(namespace, text));
}

/**
 * Bind the ChatOps agent-intent invoker (`@nimbus agent <name> k=v ...`) onto a booted ChatOps
 * graph. Mirrors `bootAgentsIntoHttpSidecar` immediately above it — same db/index/configDir/
 * llmRouter/selfIdentity shape — because both build a `buildChatopsAgentInvoker`/
 * `buildAgentHttpInvoker` deps object from the exact same boot-time collaborators.
 *
 * FIX 1 (whole-branch review): this used to be wired in `gateway-main.ts`, AFTER
 * `assemblePlatformServices` had already returned — a point at which `PlatformServices` carries
 * no federation-identity field at all, so that call site structurally could not supply
 * `selfIdentity` and always bound the invoker without one. `ipc/agents-rpc.ts`'s
 * `federatedAgentBase` falls back to `ZERO_IDENTITY` in that case, so all four
 * `federatedAgentBase` callers reachable from chat (`ghost`, `conflicts`, `huddle`, `janitor`)
 * fanned out to peers with a zero keypair and failed every peer call. Binding here instead —
 * inside `assemblePlatformServices`, right after `chatopsBoot` exists and AFTER
 * `bootFederationIntoIpcOpts` has populated `ipcOpts.federationIdentity` — gives the invoker the
 * same real identity the HTTP agent invoker already gets.
 *
 * `buildInvoker` is DI (defaults to the real `buildChatopsAgentInvoker`) purely so a test can
 * capture the deps this function assembles without a full federated dispatch or `mock.module`.
 */
export function bootChatopsAgentInvoker(deps: {
  // `Pick`, not the full `ChatopsBoot` — this function only ever calls `bindAgentInvoker`, and the
  // narrower type lets a test supply a minimal fake rather than a full `ChatopsBoot` double.
  chatopsBoot: Pick<ChatopsBoot, "bindAgentInvoker"> | undefined;
  db: Database;
  localIndex: LocalIndex;
  configDir: string;
  selfIdentity: Parameters<typeof createIpcServer>[0]["federationIdentity"];
  llmRouter: SynthesisRouter | undefined;
  agentLatencyRecorder?: AgentLatencyRecorder;
  buildInvoker?: (deps: Parameters<typeof buildChatopsAgentInvoker>[0]) => ChatopsAgentInvoker;
}): void {
  if (deps.chatopsBoot === undefined) return;
  const build = deps.buildInvoker ?? buildChatopsAgentInvoker;
  deps.chatopsBoot.bindAgentInvoker(
    build({
      db: deps.db,
      index: deps.localIndex,
      configDir: deps.configDir,
      router: deps.llmRouter,
      ...(deps.selfIdentity === undefined ? {} : { selfIdentity: deps.selfIdentity }),
      ...(deps.agentLatencyRecorder === undefined
        ? {}
        : { agentLatencyRecorder: deps.agentLatencyRecorder }),
    }),
  );
}

/** ChatOps' local-owner consent leg, bound once the IPC broadcast exists; then the bot starts. */
export function bindChatopsLocalConsent(
  ipc: IpcBroadcaster,
  chatopsBoot: ChatopsBoot | undefined,
  syncLogger: Logger,
): void {
  if (chatopsBoot === undefined) return;
  // I20 fallback leg: when the chat-routed approval is not honored (timeout / non-owner /
  // identity-invalid click), the executor falls back to the LOCAL owner — surfaced through the
  // same delegated-approval broker the CLI/UI answer (`nimbus team approve`). Re-bound here so
  // the fallback works even when chatops is enabled without federation. No subscriber /
  // timeout → false → the gate records a fail-closed rejection.
  delegatedApprovalBroker.setBroadcast((requestId, prompt) =>
    ipc.broadcast("federation.approvalRequest", { requestId, prompt }),
  );
  chatopsBoot.bindLocalConsent(async (prompt) => {
    const r = await delegatedApprovalBroker.request({ prompt }, CHATOPS_LOCAL_CONSENT_TIMEOUT_MS);
    // SA1: a ChatOps-triggered request answered through the broker is recorded as `remote`.
    return { approved: r.kind === "answered" ? r.approved : false, answerSource: "remote" };
  });
  // Headless gateway: the bot comes up with the gateway. A failed transport start (e.g. bot
  // tokens not yet provisioned) is logged and retryable via `nimbus chatops start`.
  void chatopsBoot.service
    .start()
    .catch((err: unknown) =>
      syncLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "chatops: transport start failed (provision bot tokens, then `nimbus chatops start`)",
      ),
    );
}
