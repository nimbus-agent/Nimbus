import type { NimbusChatopsToml } from "../config/nimbus-toml.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { HITL_REQUIRED, ToolExecutor } from "../engine/executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel } from "../engine/types.ts";
import type { ChatopsRpcCtx } from "../ipc/chatops-rpc.ts";
import { ConsentDisconnectedError } from "../ipc/consent.ts";
import type { TeamsEventsSurface } from "../ipc/http-write-routes.ts";
import { resolveChannelBinding, resolveOwner } from "../policy/chatops-policy.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { ApprovalPresenter } from "./approval-presenter.ts";
import {
  getChatopsApprovalContext,
  runWithChatopsApprovalContext,
} from "./chatops-request-context.ts";
import { ChatopsService } from "./chatops-service.ts";
import type { RunChatopsTool } from "./chatops-tool-runner.ts";
import { normalizeChatText, parseCommand } from "./command-parser.ts";
import { ChatopsIdentityMapper, type ScimMatch } from "./identity-mapper.ts";
import { IntentRouter } from "./intent-router.ts";
import { ReplyDispatcher } from "./reply-dispatcher.ts";
import { bunSocketFactory } from "./transport/bun-socket.ts";
import { buildConnectorPost } from "./transport/connector-post.ts";
import { SlackSocketAdapter, type SocketLike } from "./transport/slack-socket-adapter.ts";
import { TeamsWebhookAdapter } from "./transport/teams-webhook-adapter.ts";
import type { ChatTransport } from "./transport/transport.ts";
import type { ChatMessage, ChatPlatform, ReplyTarget } from "./types.ts";

export interface ChatopsBootDeps {
  readonly cfg: NimbusChatopsToml;
  /** I22: enforcement reads only the gate's EnforcedPolicy, never raw policy TOML. */
  readonly policyGate: { enforced(): EnforcedPolicy };
  /** Slice 3 identity seams (I18). Absent (identity disabled) → every user is unmapped. */
  readonly identity?: {
    readonly findScimByEmail: (email: string) => ScimMatch | undefined;
    readonly isOperatorValid: (issuer: string) => boolean;
  };
  /** Bot-credentialed connector tool invocation (chatops-tool-runner). */
  readonly runTool: RunChatopsTool;
  readonly audit: AuditSink;
  /** Dispatches an approved action to the live connector mesh (same seam as the engine). */
  readonly dispatcher: ConnectorDispatcher;
  /** I29 egress ledger: appends one row before every connector dispatch. Absent → no ledger. */
  readonly egressSink?: EgressSink;
  /** Bot Framework JWT validator (I18 verifier, aud === teamsBotAppId). Absent → the Teams
   *  events surface is NOT exposed (fail-closed). */
  readonly validateTeamsJwt?: TeamsEventsSurface["validateBotJwt"];
  readonly log: (msg: string) => void;
  readonly nowMs?: () => number;
  /** Test seams for the Slack Socket Mode adapter. */
  readonly socketFactory?: (url: string) => SocketLike;
  readonly scheduleReconnect?: (ms: number, fn: () => void) => void;
  /** Slice 6c: called for every inbound message (before routing). Never throws. */
  readonly onInboundMessage?: (m: ChatMessage) => Promise<void>;
  /**
   * Slice 6c: a chance to intercept an addressed message as a special command BEFORE the
   * IntentRouter (e.g. `tribal capture <id>`). Returns true if it handled the message (routing is
   * then skipped). Kept generic so chatops stays decoupled from the tribal subsystem.
   */
  readonly interceptCommand?: (m: ChatMessage) => Promise<boolean>;
}

export interface ChatopsBoot {
  readonly service: ChatopsService;
  readonly rpcCtx: ChatopsRpcCtx;
  /** Present only when `[chatops].teams_enabled`, a `teams_bot_app_id` is configured AND a JWT
   *  validator is wired — the I13 route stays 404 otherwise. */
  readonly teamsSurface: TeamsEventsSurface | undefined;
  /** Late-bind the engine read path (the engine agent is wired after assembly in index.ts). */
  bindAskEngine(fn: (query: string, namespace: string) => Promise<string>): void;
  /** Late-bind the local-owner consent fallback (IPC consent exists after createIpcServer). */
  bindLocalConsent(fn: ConsentChannel["requestApproval"]): void;
  /**
   * Slice 6c: the I23 reply seam (server-derived `ReplyTarget` → connector post), reused by the
   * tribal watcher to post repeat-question suggestions. Still confined to D17's allowed post path.
   */
  replyTo(target: ReplyTarget, text: string): Promise<void>;
  /**
   * Slice 6c: the chatops owner-consent channel (the same I2 fallback the chatops executor uses),
   * exposed so an in-chat tribal capture routes its HITL approval to the LOCAL owner.
   */
  requestOwnerApproval(prompt: string, details?: Record<string, unknown>): Promise<boolean>;
  /**
   * Slice 6c: true if the sender resolves to a mapped (SCIM-enrolled) identity. An intercepted
   * command (e.g. in-chat tribal capture) consults this so an unenrolled user cannot trigger the
   * owner-HITL flow — mirroring the IntentRouter's unmapped-refusal, which the intercept bypasses.
   */
  isSenderMapped(platform: ChatPlatform, userId: string): Promise<boolean>;
  stop(): Promise<void>;
}

/** MCP tool results may arrive as plain JSON or as an MCP content envelope — unwrap tolerantly. */
function unwrapToolResult(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;
  const textBlock = content.find(
    (c): c is { text: string } =>
      c !== null && typeof c === "object" && typeof (c as { text?: unknown }).text === "string",
  );
  if (textBlock === undefined) return result;
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return textBlock.text;
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** Extract the user's email from a `slack_user_info` / `teams_user_info` result (tolerant of the
 *  Slack `users.info` shape and the Graph user / list shapes). */
export function emailFromUserInfo(platform: ChatPlatform, result: unknown): string | undefined {
  const r = asRecord(result);
  if (r === undefined) return undefined;
  if (platform === "slack") {
    const profile = asRecord(asRecord(r["user"])?.["profile"]);
    const email = profile?.["email"];
    return typeof email === "string" && email !== "" ? email : undefined;
  }
  const candidates: unknown[] = [r];
  for (const key of ["items", "value"]) {
    const list = r[key];
    if (Array.isArray(list) && list.length > 0) candidates.push(list[0]);
  }
  for (const c of candidates) {
    const rec = asRecord(c);
    const email = rec?.["mail"] ?? rec?.["userPrincipalName"];
    if (typeof email === "string" && email !== "") return email;
  }
  return undefined;
}

/**
 * Build the production ChatOps component graph (Phase 6 Slice 5 boot wiring; the deferred
 * follow-up of PR #559). Wires: transports → identity mapper (I18) → policy resolvers (I22) →
 * intent router → HITL gate (I2/I20 via a ChatOps-configured ToolExecutor whose
 * `delegation.requestRemote` is the approval presenter) → bounded reply surface (I23).
 */
export function buildChatopsBoot(deps: ChatopsBootDeps): ChatopsBoot {
  const { cfg, policyGate, identity, runTool } = deps;
  const nowMs = deps.nowMs ?? ((): number => Date.now());
  const chatopsPolicy = (): EnforcedPolicy["chatops"] => policyGate.enforced().chatops;

  let askEngine: (query: string, namespace: string) => Promise<string> = () =>
    Promise.resolve("Nimbus engine is not available yet — try again shortly.");
  let localConsent: ConsentChannel["requestApproval"] | undefined;

  // Server-side routing state: which platform a channel speaks, the Bot Framework serviceUrl per
  // Teams conversation (replies must target the activity's regional endpoint), and the live
  // approval card per channel (Approve/Reject replies resolve it).
  const lastPlatformByChannel = new Map<string, ChatPlatform>();
  const teamsServiceUrlByConversation = new Map<string, string>();
  const pendingCardByChannel = new Map<string, string>();

  const post = buildConnectorPost(runTool, (conversationId) =>
    teamsServiceUrlByConversation.get(conversationId),
  );

  const replyDispatcher = new ReplyDispatcher({
    post,
    notifyChannelsFor: (namespace) => {
      const channels: string[] = [];
      for (const binding of chatopsPolicy().channels.values()) {
        if (binding.namespace !== namespace) continue;
        for (const ch of binding.notify) {
          if (!channels.includes(ch)) channels.push(ch);
        }
      }
      return channels;
    },
  });

  const presenter: ApprovalPresenter = new ApprovalPresenter({
    post: async (channelId, text) => {
      // `requestApproval` registers the pending resolver and sets lastRequestId BEFORE posting,
      // so recording the live card here is race-free (see the resolve-race note in the presenter).
      pendingCardByChannel.set(channelId, presenter.lastRequestId());
      await post(lastPlatformByChannel.get(channelId) ?? "slack", channelId, text);
    },
    // No DM surface in scope (design §3.1): the card lands in the server-derived originating
    // channel; only the owner's identity-valid click is honored (I20).
    ownerChannelFor: () => getChatopsApprovalContext()?.originatingChannelId,
  });

  const mapper = new ChatopsIdentityMapper({
    lookupEmail: async (platform, userId) => {
      try {
        const raw =
          platform === "slack"
            ? await runTool("slack", "slack_user_info", { user: userId })
            : await runTool("teams", "teams_user_info", { userId });
        return emailFromUserInfo(platform, unwrapToolResult(raw));
      } catch (e) {
        deps.log(`chatops: ${platform} user lookup failed: ${e instanceof Error ? e.message : e}`);
        return undefined;
      }
    },
    findScimByEmail: (email) => identity?.findScimByEmail(email),
    isOperatorValid: (issuer) => identity?.isOperatorValid(issuer) ?? false,
    nowMs,
    ttlSeconds: cfg.identityCacheTtlSeconds,
  });

  // ChatOps-configured executor (I2: the real gate; I4: hitlStatus only from the gate). The I20
  // delegation seam treats the policy-resolved resource OWNER as the (sole) active delegate for
  // the current write — scoped per-request via AsyncLocalStorage. Fallback consent goes to the
  // local owner via the late-bound IPC consent channel; unbound → fail-closed reject.
  const consent: ConsentChannel = {
    requestApproval: (prompt, details) => {
      if (localConsent === undefined) {
        return Promise.reject(
          new ConsentDisconnectedError(
            "chatops: no local approver bound",
            "chatops local fallback unavailable",
          ),
        );
      }
      return localConsent(prompt, details);
    },
  };
  const executor = new ToolExecutor(
    consent,
    deps.audit,
    deps.dispatcher,
    {
      store: {
        activeDelegateePeer: () => getChatopsApprovalContext()?.ownerExternalId,
        activeDelegateFor: (_scopeKind, _scopeValue, peerId) => {
          const owner = getChatopsApprovalContext()?.ownerExternalId;
          return owner !== undefined && peerId === owner;
        },
      },
      isOperatorValid: () => {
        const ctx = getChatopsApprovalContext();
        if (ctx === undefined || identity === undefined) return false;
        const scim = identity.findScimByEmail(ctx.ownerEmail);
        if (!scim?.active) return false;
        return identity.isOperatorValid(scim.issuer);
      },
      requestRemote: () => presenter.requestApproval(),
    },
    // I29: a chatops-approved write dispatches a real connector action — an outbound event — so the
    // executor carries the egress sink (append-before-dispatch). Production always wires a real
    // sink (assemble.ts); NULL_EGRESS_SINK only backstops callers (tests) that omit it, since the
    // sink is now a required constructor parameter.
    deps.egressSink ?? NULL_EGRESS_SINK,
  );
  const knownActions = HITL_REQUIRED;

  const routerFor = (msg: ChatMessage): IntentRouter =>
    new IntentRouter({
      knownActions,
      resolveBinding: (channelId) => resolveChannelBinding(chatopsPolicy(), channelId),
      resolveIdentity: (platform, userId) => mapper.resolve(platform, userId),
      resolveOwner: (resource) => resolveOwner(chatopsPolicy(), resource),
      ownerExternalIdFor: (email) => {
        const scim = identity?.findScimByEmail(email);
        return scim?.active === true ? scim.externalId : undefined;
      },
      askEngine: (query, namespace) => askEngine(query, namespace),
      runGatedWrite: (actionType, args, owner, requesterExternalId, originatingChannelId) =>
        runWithChatopsApprovalContext(
          {
            ownerEmail: owner.email,
            ownerExternalId: owner.externalId,
            originatingChannelId,
            requesterExternalId,
            actionLabel: `${actionType} ${JSON.stringify(args)}`,
          },
          async () => {
            const result = await executor.execute({ type: actionType, payload: { ...args } });
            pendingCardByChannel.delete(originatingChannelId);
            return { approved: result.status === "ok" };
          },
        ),
      reply: (text) =>
        replyDispatcher.send(
          { kind: "originating", platform: msg.platform, channelId: msg.channelId },
          text,
        ),
      auditRefusal: (reason, detail, channelId) =>
        deps.audit.recordAudit({
          actionType: "chatops.refusal",
          hitlStatus: "not_required",
          actionJson: JSON.stringify({ reason, detail, channelId }),
          timestamp: nowMs(),
        }),
    });

  const handleMessage = async (msg: ChatMessage): Promise<void> => {
    lastPlatformByChannel.set(msg.channelId, msg.platform);
    // Slice 6c fan-out: every inbound message (addressed or ambient) flows to the tribal
    // watcher first. It swallows its own errors, so this never breaks the command path.
    if (deps.onInboundMessage !== undefined) await deps.onInboundMessage(msg);
    const normalized = normalizeChatText(msg.text).toLowerCase();
    if (normalized === "approve" || normalized === "reject") {
      const requestId = pendingCardByChannel.get(msg.channelId);
      if (requestId !== undefined) {
        // Resolve the clicker identity; an unmapped reply never spends the card. A mapped
        // non-owner click resolves it, and the executor's I20 check refuses to honor it.
        const idr = await mapper.resolve(msg.platform, msg.userId);
        if (idr.kind === "mapped") {
          pendingCardByChannel.delete(msg.channelId);
          presenter.resolveClick({
            requestId,
            approverExternalId: idr.identity.externalId,
            approved: normalized === "approve",
          });
        }
        return; // a verdict on a live card is never routed as a command
      }
    }
    // Ambient (non-addressed) messages are tribal-only — never routed as a command. Today all
    // delivered messages were @-mentions (addressedToBot=true), so this preserves behavior.
    if (!msg.addressedToBot) return;
    // Slice 6c: a special command (e.g. `tribal capture <id>`) is intercepted before the router.
    if (deps.interceptCommand !== undefined && (await deps.interceptCommand(msg))) return;
    await routerFor(msg).handle(msg);
  };

  const transports: ChatTransport[] = [];
  if (cfg.slackEnabled) {
    transports.push(
      new SlackSocketAdapter({
        openSocket: async () => {
          const r = asRecord(unwrapToolResult(await runTool("slack", "slack_socket_open", {})));
          const url = r?.["url"];
          if (typeof url !== "string" || url === "") {
            throw new Error("chatops: slack_socket_open returned no socket url");
          }
          return { url };
        },
        socketFactory: deps.socketFactory ?? bunSocketFactory,
        ...(deps.scheduleReconnect === undefined
          ? {}
          : { scheduleReconnect: deps.scheduleReconnect }),
      }),
    );
  }
  let teamsAdapter: TeamsWebhookAdapter | undefined;
  if (cfg.teamsEnabled) {
    teamsAdapter = new TeamsWebhookAdapter();
    transports.push(teamsAdapter);
  }

  const service = new ChatopsService({
    enabled: cfg.enabled,
    transports,
    handleMessage,
    channelsForPlatform: () => chatopsPolicy().channels.size,
    testParse: (text) => parseCommand(text, knownActions),
    nowMs,
  });

  const teamsSurface: TeamsEventsSurface | undefined =
    cfg.teamsEnabled &&
    cfg.teamsBotAppId !== "" &&
    deps.validateTeamsJwt !== undefined &&
    teamsAdapter !== undefined
      ? {
          teamsBotAppId: cfg.teamsBotAppId,
          validateBotJwt: deps.validateTeamsJwt,
          onActivity: async (activity) => {
            const a = asRecord(activity);
            const serviceUrl = a?.["serviceUrl"];
            const conversationId = asRecord(a?.["conversation"])?.["id"];
            if (typeof serviceUrl === "string" && typeof conversationId === "string") {
              teamsServiceUrlByConversation.set(conversationId, serviceUrl);
            }
            await teamsAdapter?.onActivity(activity);
          },
        }
      : undefined;

  return {
    service,
    rpcCtx: {
      status: () => service.status(),
      start: () => service.start(),
      stop: () => service.stop(),
      testParse: (text) => service.testParse(text),
    },
    teamsSurface,
    bindAskEngine: (fn) => {
      askEngine = fn;
    },
    bindLocalConsent: (fn) => {
      localConsent = fn;
    },
    replyTo: (target, text) => replyDispatcher.send(target, text),
    requestOwnerApproval: (prompt, details) => consent.requestApproval(prompt, details),
    isSenderMapped: async (platform, userId) =>
      (await mapper.resolve(platform, userId)).kind === "mapped",
    stop: () => service.stop(),
  };
}
