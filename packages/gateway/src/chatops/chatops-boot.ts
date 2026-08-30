import type { Database } from "bun:sqlite";
import type { ChatopsAgentInvoker } from "../agent-runs/agent-chatops-invoke.ts";
import type { NimbusChatopsToml } from "../config/nimbus-toml.ts";
import { buildLedgeredChatPosts } from "../egress/chatops-egress.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import { EgressAppendFailedError } from "../egress/model-egress.ts";
import { HITL_REQUIRED, ToolExecutor } from "../engine/executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel } from "../engine/types.ts";
import { EXTERNAL_AGENT_NAMES } from "../ipc/agents-rpc.ts";
import type { ChatopsRpcCtx } from "../ipc/chatops-rpc.ts";
import { ConsentDisconnectedError } from "../ipc/consent.ts";
import type { TeamsEventsSurface } from "../ipc/http-write-routes.ts";
import { resolveChannelBinding, resolveOwner } from "../policy/chatops-policy.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { isHitlRequiredByPolicy } from "../policy/quorum-override.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { ApprovalPresenter } from "./approval-presenter.ts";
import { truncateBrief } from "./brief-truncate.ts";
import { ensureChannelSalt } from "./channel-salt.ts";
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

/**
 * A readability cap, conservatively under every platform ceiling — not a specific Slack/Teams
 * limit asserted from this repo (the connector body that actually calls chat.postMessage lives
 * in the separate nimbus-mcp-servers repo and is not installed here, so neither platform's real
 * ceiling can be verified from this codebase). A multi-kilobyte wall of markdown in a shared
 * channel is already past readable regardless of what either platform would technically accept,
 * and bytes ≤ chars keeps the cap conservative rather than generous.
 *
 * FIX 2 (whole-branch review) corrected a claim this comment used to make: `truncateBrief` does
 * NOT simply "never drop a disclosure regardless of the cap chosen". It still never drops a
 * DISCLOSURE (I31's `## Gaps` and negotiate's two sections) — but this cap always binds. When
 * even the disclosure-only reserved content alone cannot fit (rare, and rarer still now that the
 * chat surface clamps `glossary`'s `limit`, see `CHATOPS_GLOSSARY_LIST_LIMIT_MAX` below), it is
 * cut too, with an unambiguous "content was cut" notice — a truncated message is better than one
 * the platform silently mangles server-side for exceeding its own limit. `## Terms`
 * (`glossary` list mode's entry table) is shrunk FIRST, before any disclosure content is ever
 * touched: it is reserved for SYNTHESIS integrity, not disclosure — see
 * `agents/_lib/reserved-sections.ts`'s `SYNTHESIS_RESERVED_HEADINGS` (fail-closed: an unrecognised
 * heading is never treated as droppable).
 */
export const CHATOPS_AGENT_BRIEF_MAX_BYTES = 3_000;

/**
 * FIX 2 (whole-branch review): clamps `agent glossary limit=<n>` on the CHAT surface only, so
 * `truncateBrief`'s forced-fit path above is reached rarely rather than routinely — glossary is
 * the agent most likely to exceed `CHATOPS_AGENT_BRIEF_MAX_BYTES`, since in list mode `## Terms`
 * (a reserved, undroppable-by-default section) IS the entire brief.
 *
 * Deliberately NOT a change to `ipc/agents-rpc.ts`'s `requireGlossaryParams`, which enforces only
 * "a positive integer" and is shared with the IPC and HTTP surfaces — `nimbus glossary
 * limit=5000` from the CLI, or the identical call over `POST /v1/agents/glossary`, is untouched;
 * only a chat-issued command is clamped.
 */
export const CHATOPS_GLOSSARY_LIST_LIMIT_MAX = 20;

/**
 * Clamp `params.limit` down to `CHATOPS_GLOSSARY_LIST_LIMIT_MAX` for a chat-issued `agent
 * glossary ...` command — only when it is otherwise well-formed (a finite integer above the
 * clamp). Any other shape (missing, non-numeric, non-integer, negative) passes through
 * unchanged so `requireGlossaryParams`'s own validation still produces the real error for it;
 * this function's job is narrowing an over-large but valid request, not validating one.
 */
function clampGlossaryLimitForChat(agent: string, params: unknown): unknown {
  if (agent !== "glossary") return params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return params;
  const p = params as Record<string, unknown>;
  const limit = p["limit"];
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit <= CHATOPS_GLOSSARY_LIST_LIMIT_MAX
  ) {
    return params;
  }
  return { ...p, limit: CHATOPS_GLOSSARY_LIST_LIMIT_MAX };
}

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
  /** I29 `chatops` class: the ledger every outbound post is appended to. REQUIRED — a chatops
   *  boot that cannot ledger must not be constructible. */
  readonly db: Database;
  /** Holds the per-install channel-hash salt (`chatops.channel.salt`). */
  readonly vault: NimbusVault;
  readonly audit: AuditSink;
  /** Dispatches an approved action to the live connector mesh (same seam as the engine). */
  readonly dispatcher: ConnectorDispatcher;
  /**
   * I29 egress ledger: appends one row before every connector dispatch. This executor is
   * dispatch-capable (it reaches real connector actions via `deps.dispatcher`), so the sink is
   * REQUIRED — production wires a real one (`platform/assemble.ts`); a caller that wants to opt
   * out (e.g. a test) must pass `NULL_EGRESS_SINK` explicitly so that choice is visible at the
   * call site instead of silently defaulted.
   */
  readonly egressSink: EgressSink;
  /** Bot Framework JWT validator (I18 verifier, aud === teamsBotAppId). Absent → the Teams
   *  events surface is NOT exposed (fail-closed). */
  readonly validateTeamsJwt?: TeamsEventsSurface["validateBotJwt"];
  readonly log: (msg: string) => void;
  /**
   * Design §13.1: a failed egress-ledger append on an outbound post must be LOUD in the gateway
   * log at `error` — nothing can be posted in-channel to say so (that would itself be an
   * unledgerable post), and no `degraded` marker either (that is itself a row). Structured so the
   * underlying `Error` survives intact (see #1393 — a bare string interpolation is exactly the
   * "err":{} bug that fix closed). Optional so a caller that only cares about `log` need not
   * change; falls back to it (at a lower apparent severity) when absent.
   */
  readonly logError?: (fields: Readonly<Record<string, unknown>>, msg: string) => void;
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
  /**
   * Late-bind the `agents.*` invoker (`buildChatopsAgentInvoker`): `ChatopsBootDeps` does not
   * carry the `LocalIndex`/`configDir`/`selfIdentity`/`SynthesisRouter` deps that invoker needs,
   * so `platform/assemble.ts`'s `bootChatopsAgentInvoker` wires it right after this boot
   * function returns — inside `assemblePlatformServices`, not (as it used to be) after it, in
   * `gateway-main.ts`. That move is FIX 1 of the whole-branch review: the old post-assembly call
   * site had no federation-identity field to read at all, so `selfIdentity` was always omitted.
   * Unbound, `runAgent` falls back to a fail-closed stub (same shape as the pre-bind `askEngine`).
   */
  bindAgentInvoker(fn: ChatopsAgentInvoker): void;
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
export async function buildChatopsBoot(deps: ChatopsBootDeps): Promise<ChatopsBoot> {
  const { cfg, policyGate, identity, runTool } = deps;
  const nowMs = deps.nowMs ?? ((): number => Date.now());
  const logError =
    deps.logError ?? ((fields, msg): void => deps.log(`${msg} ${JSON.stringify(fields)}`));
  const chatopsPolicy = (): EnforcedPolicy["chatops"] => policyGate.enforced().chatops;

  let askEngine: (query: string, namespace: string) => Promise<string> = () =>
    Promise.resolve("Nimbus engine is not available yet — try again shortly.");
  let agentInvoker: ChatopsAgentInvoker = () =>
    Promise.resolve({ ok: false as const, detail: "Agent commands are not available yet." });
  let localConsent: ConsentChannel["requestApproval"] | undefined;

  // Server-side routing state: which platform a channel speaks, the Bot Framework serviceUrl per
  // Teams conversation (replies must target the activity's regional endpoint), and the live
  // approval card per channel (Approve/Reject replies resolve it).
  const lastPlatformByChannel = new Map<string, ChatPlatform>();
  const teamsServiceUrlByConversation = new Map<string, string>();
  const pendingCardByChannel = new Map<string, string>();

  // I29 `chatops` class: every outbound post is ledgered before it leaves the machine. The raw
  // connector post is passed INLINE, never bound to a name — an unwrapped post in scope would be
  // a bypass waiting for the next consumer to reach for it (static D17 extension).
  const channelSalt = await ensureChannelSalt(deps.vault);
  const posts = buildLedgeredChatPosts(
    deps.db,
    buildConnectorPost(runTool, (conversationId) =>
      teamsServiceUrlByConversation.get(conversationId),
    ),
    channelSalt,
  );

  // Shared by both operational (non-HITL) reply dispatchers below -- I23 names
  // `ReplyDispatcher.send` as the SOLE post path for this class of post; an agent brief is
  // operational too, so it gets its own `ReplyDispatcher` instance (same server-derived
  // target-resolution rules) rather than a second, dispatcher-bypassing post helper.
  const notifyChannelsFor = (namespace: string): string[] => {
    const channels: string[] = [];
    for (const binding of chatopsPolicy().channels.values()) {
      if (binding.namespace !== namespace) continue;
      for (const ch of binding.notify) {
        if (!channels.includes(ch)) channels.push(ch);
      }
    }
    return channels;
  };
  const replyDispatcher = new ReplyDispatcher({ post: posts.reply, notifyChannelsFor });
  // I23: the agent-brief counterpart of `replyDispatcher` above -- posts through `posts.agentBrief`
  // (ledgered `chatops.agentBrief`, I29) instead of `posts.reply`, but is otherwise the exact same
  // dispatcher shape, so `routerFor`'s reply redirect (below) never has to bypass ReplyDispatcher
  // to change which post kind a reply ledgers as.
  const agentBriefDispatcher = new ReplyDispatcher({ post: posts.agentBrief, notifyChannelsFor });

  const presenter: ApprovalPresenter = new ApprovalPresenter({
    post: async (channelId, text) => {
      // `requestApproval` registers the pending resolver and sets lastRequestId BEFORE posting,
      // so recording the live card here is race-free (see the resolve-race note in the presenter).
      const requestId = presenter.lastRequestId();
      pendingCardByChannel.set(channelId, requestId);
      try {
        await posts.approvalCard(lastPlatformByChannel.get(channelId) ?? "slack", channelId, text);
      } catch (err) {
        // The append-before-post ledger (I29 `chatops` class) failed, so nothing was posted — the
        // owner never saw a card. The pending entry must not outlive that failure, or a later
        // "approve" in this channel would resolve an approval card that was never shown (fail-
        // closed: only clear OUR entry, in case a newer request already replaced it).
        if (pendingCardByChannel.get(channelId) === requestId) {
          pendingCardByChannel.delete(channelId);
        }
        throw err;
      }
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
    // executor carries the egress sink (append-before-dispatch). `egressSink` is a REQUIRED dep
    // (see the doc comment on `ChatopsBootDeps.egressSink`) — production always wires a real sink
    // (assemble.ts); a caller that wants no ledger passes `NULL_EGRESS_SINK` explicitly.
    deps.egressSink,
    // I22: chatops already holds the same `policyGate` it reads `chatops` config from, so the
    // tighten-only HITL overlay comes straight off it. A signed `[policy.hitl] require` entry has
    // to bind here too — a chat-triggered action is the same executor path as a local one.
    { isHitlRequiredByPolicy: (t) => isHitlRequiredByPolicy(policyGate.enforced(), t) },
  );
  const knownActions = HITL_REQUIRED;

  const routerFor = (msg: ChatMessage): IntentRouter => {
    // Set by `runAgent` below on a successful brief, consumed by `reply` immediately after —
    // IntentRouter always calls `deps.reply(result.markdown)` for an ok agent result, and that
    // single reply is what must go out through `agentBriefDispatcher` (→ `posts.agentBrief`)
    // rather than the generic `replyDispatcher` (→ `posts.reply`) every other kind uses, so the
    // ledger records ONE row with `method='chatops.agentBrief'` (never two: one 'chatops.reply'
    // plus one 'chatops.agentBrief' for the same text). A bare boolean, not the markdown itself —
    // `reply` posts its OWN `text` argument, never a value stashed here, so a future edit that
    // decorates `result.markdown` before replying can never see the wrapper silently post a stale
    // copy. Scoped to this `routerFor(msg)` closure, which is built fresh per inbound message, so
    // concurrent messages never share this flag.
    let isAgentBrief = false;

    return new IntentRouter({
      knownActions,
      // The eleven externally-exposed agents (`EXTERNAL_AGENT_NAMES`, derived — never hand-listed)
      // are permitted for every mapped identity; the executor/HITL gate governs writes, not this
      // set, and every agent here is read-only by construction (nimbus-agent-patterns).
      permittedAgents: new Set(EXTERNAL_AGENT_NAMES),
      runAgent: async (agent, params) => {
        // FIX 2: clamp glossary's `limit` before dispatch, so the forced-fit path in
        // `truncateBrief` below is the rare case, not the routine one.
        const result = await agentInvoker(agent, clampGlossaryLimitForChat(agent, params));
        if (!result.ok) return result;
        // Truncation to a platform byte cap is boot wiring's job (Task 9), not the router's or
        // the invoker's — see `IntentRouterDeps.runAgent`'s doc comment.
        const markdown = truncateBrief(result.markdown, agent, CHATOPS_AGENT_BRIEF_MAX_BYTES);
        isAgentBrief = true;
        return { ok: true, markdown };
      },
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
      reply: (text) => {
        const target = {
          kind: "originating" as const,
          platform: msg.platform,
          channelId: msg.channelId,
        };
        if (isAgentBrief) {
          isAgentBrief = false;
          return agentBriefDispatcher.send(target, text);
        }
        return replyDispatcher.send(target, text);
      },
      auditRefusal: (reason, detail, channelId) =>
        deps.audit.recordAudit({
          actionType: "chatops.refusal",
          hitlStatus: "not_required",
          actionJson: JSON.stringify({ reason, detail, channelId }),
          timestamp: nowMs(),
        }),
    });
  };

  const handleMessageInner = async (msg: ChatMessage): Promise<void> => {
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

  /**
   * Design §13.1: a failed egress-ledger append (e.g. the index DB is locked mid-reindex,
   * read-only, or full) must not take the whole gateway down. Structurally nothing was posted —
   * `buildLedgeredChatPosts` appends before it ever calls the raw post — so containing this here
   * loses nothing that was going to be said in-channel; it only stops an unhandled rejection from
   * reaching `platform/exit-diagnostics.ts`'s `unhandledRejection` handler and exiting the process
   * (traced: `ReplyDispatcher.send` → `IntentRouter.handle` → here → `ChatopsService`'s
   * `t.onMessage` callback → `SlackSocketAdapter`'s `void this.onFrame(...)` → `host.exit(1)`).
   * ONLY `EgressAppendFailedError` is caught — every other error (a bad command parse, a connector
   * failure, a bug) still propagates and still crashes loudly, which is correct: this seam
   * contains one named, anticipated failure mode, not errors in general.
   */
  const handleMessage = async (msg: ChatMessage): Promise<void> => {
    try {
      await handleMessageInner(msg);
    } catch (err) {
      if (!(err instanceof EgressAppendFailedError)) throw err;
      const postKind = err.context?.["chatopsPostKind"];
      const channelId = err.context?.["chatopsChannelId"] ?? msg.channelId;
      logError(
        {
          channelId, // unhashed on purpose — this is the log, not the ledger (§13.1)
          postKind: typeof postKind === "string" ? postKind : "unknown",
          platform: msg.platform,
          err,
        },
        "chatops: outbound post blocked — egress ledger append failed, nothing was posted",
      );
    }
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
    testParse: (text) => parseCommand(text, knownActions, new Set(EXTERNAL_AGENT_NAMES)),
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
    bindAgentInvoker: (fn) => {
      agentInvoker = fn;
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
