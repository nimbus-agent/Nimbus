import type { Agent } from "@mastra/core/agent";
import { resolvePersona } from "../config/persona.ts";
import type {
  ConnectorWriteRow,
  PreviewCredentialResolver,
  TribalKbConfig,
} from "../connectors/connector-writes/types.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import { earliestHistoryMs, type PointInTimeFacts } from "../index/item-history-at.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { LlmRouter } from "../llm/router.ts";
import type { SessionMemoryStore } from "../memory/session-memory-store.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { createStandingRuleDeps } from "../standing/standing-rule-capability.ts";
import type { AgentLatencyRecorder } from "../telemetry/agent-latency.ts";
import { gatewayZone } from "../util/zoned-time.ts";
import {
  agentRequestContext,
  type ComputerUseBinding,
  getAgentRequestSessionId,
} from "./agent-request-context.ts";
import type { AskExplainRecorder } from "./ask-explain-recorder.ts";
import { createBeforeStateRunner } from "./before-state.ts";
import { COMPUTER_USE_TURN_REFUSALS, ComputerUseTurnError } from "./computer-use-turn-error.ts";
import {
  bindConsentChannel,
  type ExecutorDelegationDep,
  type ExecutorPolicyDep,
  NO_POLICY_OVERLAY,
  ToolExecutor,
  type ToolExecutorExtras,
} from "./executor.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { indexCountFor, indexCountLine } from "./index-count-question.ts";
import { createOwnerOnlyAsk } from "./owner-only-approval.ts";
import { type PlanResult, planFromIntent } from "./planner.ts";
import type { ClassifiedIntent } from "./router.ts";
import { classifyIntentForAskWithLocalFallback } from "./run-ask/classify.ts";
import { countIndexedItems, emptyIndexGuidanceIfNeeded } from "./run-ask/empty-index.ts";
import {
  conversationalExplainRoute,
  describePlan,
  type ExplainPartial,
  recordExplainSafely,
} from "./run-ask/explain.ts";
import { buildLocalIndexedContext } from "./run-ask/local-context.ts";
import { runAskLog } from "./run-ask/log.ts";
import type { RunAskResult } from "./run-ask/result.ts";
import {
  formatResultSummary,
  loadRecentConversationHistory,
  persistConversationTurn,
} from "./run-ask/turn-helpers.ts";
import { runConversationalAgent } from "./run-conversational-agent.ts";
import type { NotifyGasLimit } from "./step-budget.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel, PlannedAction } from "./types.ts";

// The split's facade: every name `run-ask.ts` exported before the split is still exported from here.
export { resolveLocalContextItemLimit } from "./run-ask/local-context.ts";
export type { RunAskResult } from "./run-ask/result.ts";

/** The arguments every turn executor is built from; `RunAskParams` carries them all. */
export type ExecutorBuildParams = Pick<
  RunAskParams,
  | "clientId"
  | "consentCoordinator"
  | "localIndex"
  | "dispatcher"
  | "egressSink"
  | "policyHitl"
  | "previewCredentialFor"
  | "userMcpWriteGrants"
>;

export type RunAskParams = {
  input: string;
  stream: boolean;
  clientId: string;
  paths: PlatformPaths;
  consentCoordinator: ConsentCoordinator;
  localIndex: LocalIndex;
  dispatcher: ConnectorDispatcher;
  /**
   * I29 egress ledger: appends one row before every connector dispatch. This is the agent-action
   * path (`nimbus ask` / `agent.invoke` / the ChatOps read path) — the most dispatch-capable path
   * in the product, and the one `nimbus prove` itself exercises. The sink is therefore REQUIRED —
   * production wires a real one (`makeEgressSink(db)`, see `index.ts`); a caller that genuinely
   * wants no ledger (e.g. a test exercising a gate-only path) must pass `NULL_EGRESS_SINK`
   * explicitly so that choice is visible at the call site instead of silently defaulted.
   */
  egressSink: EgressSink;
  sendChunk: (text: string) => void;
  conversationalAgent?: Agent;
  llmRouter?: LlmRouter;
  /**
   * Devil's-advocate mode (`nimbus ask --devil`). Forces the conversational route — the mode
   * argues in prose, and plan dispatch has nothing to argue with — and threads the directive
   * through to `runConversationalAgent`. See `engine/devil-advocate.ts`.
   */
  devil?: boolean;
  /**
   * `nimbus ask --at`: answer as the index stood at this instant (Phase 10 IC1). Forces the conversational
   * route (the classifier and plan dispatch are skipped, as `--devil` does), withdraws every live read and
   * write from the turn, and appends the deterministic as-of block. Parsed and bounds-checked at the IPC
   * entry (`dispatchAgentInvoke`); never read from the model.
   */
  pointInTimeMs?: number;
  sessionMemoryStore?: SessionMemoryStore;
  classify?: (input: string) => Promise<ClassifiedIntent>;
  // Owner-side delegated HITL (Slice 2, I20). When present, the executor gate routes a HITL action's
  // approval to an active in-scope delegate over federation before falling back to the local prompt.
  delegation?: ExecutorDelegationDep;
  // I22 — the tighten-only HITL overlay from a signature-verified org policy. Absent means
  // "frozen set only". This is the path agent-PLANNED actions take, so it is the one an org's
  // `[policy.hitl] require` list most needs to reach.
  policyHitl?: ExecutorPolicyDep;
  /** Names the credential kind in a connector write's consent preview (config-derived). */
  previewCredentialFor?: PreviewCredentialResolver;
  /**
   * I15 (AD5b): what a registered user MCP server may write, for the prompt of a call to it. An
   * executor built without it refuses every `mcp_*` call before any prompt (fail closed).
   */
  userMcpWriteGrants?: (serviceId: string) => readonly string[] | undefined;
  /**
   * Test seam ONLY (pinned by the I53 block): the rows the door executor previews and reads with.
   * Production never sets it, so the runner uses the write table.
   */
  beforeStateRows?: readonly ConnectorWriteRow[];
  /**
   * The tribal knowledge-base destinations, read live (B3, R11): the door runner's KB-child guards
   * read them through a frozen per-read snapshot. REQUIRED, so a construction site cannot forget
   * it; ChatOps never offers model writes, so its value there is inert.
   */
  getTribalKbConfig: () => TribalKbConfig | undefined;
  /**
   * `nimbus explain last` (spec §4). Absent means "no recorder wired" — a test double or a
   * gate-only caller that has no use for it — in which case `runAsk` records nothing rather than
   * fabricating a recorder. Recording happens exactly once per call, success or throw (spec
   * §4.2): a caller that only recorded on success would leave `explain last` showing the
   * PREVIOUS successful ask at the moment the user most needs the truth.
   */
  explainRecorder?: AskExplainRecorder;
  /**
   * Telemetry `agent_invocation_latency_p50_ms`/`_p95_ms`: one DURATION per call, recorded at the
   * same two exits as the explain entry (success and throw), so the timed population is exactly
   * the one `nimbus explain last` sees. Only the number is recorded — no question, no client id.
   * Absent means nothing is recorded.
   */
  agentLatencyRecorder?: AgentLatencyRecorder;
  /**
   * Offer the owner-registered user-MCP tools (`connector add --mcp --model`, I42) on this turn.
   * Only `=== true` offers: `runAsk` then puts this turn's dispatching executor into the request
   * context, and its PRESENCE is what `engine/agent.ts` reads as the offer signal.
   *
   * An explicit flag decided by the CALLER, never a kind lookup in here: the IPC entry decides it
   * from the live session's `ClientKind` (`USER_MCP_OFFER_BY_KIND`), while ChatOps calls `runAsk`
   * with clientId `"chatops"`, which is not a registered kind and would read as `unknown` — i.e.
   * as the local owner — if this function looked it up.
   */
  offerUserMcpTools?: boolean;
  /**
   * Offer the model's connector-write door (Phase 9.7) on this turn. Only `=== true` offers, and
   * never on a demo-rooted gateway: `runAsk` then puts a delegation-free executor into the request
   * context (`connectorWriteExecutor`), whose PRESENCE `engine/agent.ts` reads as the offer signal.
   * Decided by the CALLER from the live session's `ClientKind` (`CONNECTOR_WRITE_OFFER_BY_KIND`,
   * only `cli` / `ui`); ChatOps passes a literal `false`.
   */
  offerConnectorWriteTools?: boolean;
  /**
   * Whether this turn may drive a computer-use session (I35, OR-MCU-1): decided by the CALLER from
   * the live session's `ClientKind` (`COMPUTER_USE_OFFER_BY_KIND`, `cli` only). Only `=== true`
   * offers, never on a demo-rooted gateway and never on a point-in-time turn.
   */
  offerComputerUse?: boolean;
  /** The session the owner named with `nimbus ask --computer <id>`. */
  computerSessionId?: string;
  /**
   * Resolves a session this process holds OPEN to its binding (run deps only; every action prompt
   * goes to the connection that opened it), or `undefined` when it is not open or computer-use is off.
   */
  computerUseFor?: (sessionId: string) => ComputerUseBinding | undefined;
  /**
   * Told when the agent step budget cut this turn short (`engine/step-budget.ts`). Only the IPC
   * entry supplies it, as a UNICAST `agent.gasLimitReached` to the acting session; every other
   * caller (ChatOps, workflow) relies on the deterministic disclosure line in the reply.
   */
  notifyGasLimit?: NotifyGasLimit;
};

/**
 * Whether this turn runs on a demo-rooted gateway (I41). DERIVED from the required `paths` —
 * never a second flag a caller could set differently, and never the env var — so every `runAsk`
 * caller (the IPC handler and ChatOps alike) is demo-aware without having to remember to be.
 * In the demo, connector auth/sync are refused and the org is seeded by `nimbus demo`, so the
 * real-install empty-index and no-LLM guidance are both wrong there.
 */
function isDemo(p: RunAskParams): boolean {
  return p.paths.demo === true;
}

function canUseConversation(p: RunAskParams): boolean {
  return p.conversationalAgent !== undefined || p.llmRouter?.prefersLocal() === true;
}

/**
 * Put this turn's dispatching executor into the request context when — and only when — the
 * caller decided this is the local owner's turn (`p.offerUserMcpTools === true`). Its presence is
 * the offer signal `engine/agent.ts` reads. Otherwise the slot is cleared, so a store reused by a
 * caller can never carry an earlier turn's executor into a non-owner one. No store (a bare call
 * outside any `agentRequestContext.run`) means nothing to offer through.
 */
/** Records this turn's instant on the request store (cleared otherwise), so `toolsFor` reads the same fact. */
function markPointInTimeTurn(atMs: number | undefined): void {
  const store = agentRequestContext.getStore();
  if (store === undefined) return;
  if (atMs === undefined) {
    delete store.pointInTimeMs;
  } else {
    store.pointInTimeMs = atMs;
  }
}

/** A time-travel turn carries no user-MCP or connector-write executor, whatever a reused store held. */
function withdrawOfferedExecutors(): void {
  const store = agentRequestContext.getStore();
  if (store === undefined) return;
  delete store.userMcpExecutor;
  delete store.connectorWriteExecutor;
  delete store.toolgenModelAsk;
  delete store.computerUse;
}

function offerUserMcpExecutorIfOwner(p: RunAskParams): void {
  const store = agentRequestContext.getStore();
  if (store === undefined) return;
  if (p.offerUserMcpTools === true) {
    store.userMcpExecutor = buildAskExecutor(p);
  } else {
    delete store.userMcpExecutor;
  }
}

/**
 * The same, for the connector-write door: set only when the caller decided this is the local
 * owner's `cli`/`ui` turn (`p.offerConnectorWriteTools === true`) AND the gateway is not
 * demo-rooted (I41); cleared otherwise, so a reused store never carries it into another turn.
 */
function offerConnectorWriteExecutorIfOwner(p: RunAskParams): void {
  const store = agentRequestContext.getStore();
  if (store === undefined) return;
  if (p.offerConnectorWriteTools === true && !isDemo(p)) {
    store.connectorWriteExecutor = buildModelWriteExecutor(p);
    // I60: the same decision offers the owner's saved generated tools, each call behind a person's
    // approval on THIS connection (no delegation, a non-human answer is a decline).
    store.toolgenModelAsk = createOwnerOnlyAsk({
      consent: bindConsentChannel(p.consentCoordinator, p.clientId),
      audit: p.localIndex,
      policyHitl: p.policyHitl,
    });
  } else {
    delete store.connectorWriteExecutor;
    delete store.toolgenModelAsk;
  }
}

/**
 * Bind the computer-use session the owner named to this turn (I35, OR-MCU-1) when, and only when,
 * the caller decided this is the local owner's `cli` turn (`p.offerComputerUse === true`), the
 * gateway is not demo-rooted, and the platform resolves the id to an OPEN session; cleared
 * otherwise, so a reused store never carries an earlier turn's binding.
 */
function bindComputerUseIfOwner(p: RunAskParams): void {
  const store = agentRequestContext.getStore();
  if (store === undefined) return;
  delete store.computerUse;
  if (p.computerSessionId === undefined) return;
  // A turn that NAMED a session drives it or fails explicitly: never a silent answer without it.
  if (p.offerComputerUse !== true) {
    throw new ComputerUseTurnError(COMPUTER_USE_TURN_REFUSALS.notTerminal);
  }
  if (isDemo(p)) throw new ComputerUseTurnError(COMPUTER_USE_TURN_REFUSALS.demo);
  const binding = p.computerUseFor?.(p.computerSessionId);
  if (binding === undefined) throw new ComputerUseTurnError(COMPUTER_USE_TURN_REFUSALS.notOpen);
  // The local router answers with no tools at all, so a bound session would silently do nothing.
  if (
    p.conversationalAgent === undefined ||
    p.llmRouter?.prefersLocal() === true ||
    p.llmRouter?.enforcesAirGap() === true
  ) {
    throw new ComputerUseTurnError(COMPUTER_USE_TURN_REFUSALS.noAgent);
  }
  store.computerUse = binding;
}

/**
 * The conversational answer path: prior turns + optional indexed context → the agent/router,
 * then persist the turn.
 *
 * Extracted so the two routes that reach it — the classifier's verdict and `--devil`, which
 * bypasses the classifier — cannot drift apart. A second inline copy for devil mode would be
 * one session-memory or local-context fix away from applying to only one of them.
 */
async function answerConversationally(
  p: RunAskParams,
  partial: ExplainPartial,
): Promise<RunAskResult> {
  const atMs = p.pointInTimeMs;
  markPointInTimeTurn(atMs);
  if (atMs === undefined) {
    offerUserMcpExecutorIfOwner(p);
    offerConnectorWriteExecutorIfOwner(p);
    bindComputerUseIfOwner(p);
  } else {
    // A time-travel turn is never offered a write or a live read (plan deviation 14).
    withdrawOfferedExecutors();
  }
  const sessionId = getAgentRequestSessionId();
  // A time-travel turn neither reads nor writes session history: an earlier reply may describe events after T
  // (evidence for the wrong instant), and this reply is about T, not about the session's present.
  const priorTurns =
    atMs === undefined ? await loadRecentConversationHistory(p.sessionMemoryStore, sessionId) : [];
  partial.stage = "retrieval";
  const searchedFacts: PointInTimeFacts[] = [];
  const localContext = shouldBuildLocalContext(p)
    ? await buildLocalIndexedContext(p.localIndex, p.input, atMs, searchedFacts)
    : undefined;

  // Same guard as `countIndexedItems`: `localIndex.getDatabase` is optional on the interface, and
  // a test stub without it must not take the whole turn down over a disclosure line.
  const countDb =
    typeof p.localIndex.getDatabase === "function" ? p.localIndex.getDatabase() : undefined;
  // The "N indexed" line is a CURRENT count: omitted on a point-in-time turn.
  const count =
    countDb === undefined || atMs !== undefined ? undefined : indexCountFor(countDb, p.input);
  const countLine = count === undefined ? undefined : indexCountLine(count);

  partial.stage = "model";
  const result = await runConversationalAgent({
    input: p.input,
    stream: p.stream,
    sendChunk: p.sendChunk,
    priorTurns,
    ...(p.conversationalAgent === undefined ? {} : { agent: p.conversationalAgent }),
    ...(p.llmRouter === undefined ? {} : { llmRouter: p.llmRouter }),
    ...(localContext === undefined
      ? {}
      : { localContext: localContext.text, localContextTruncation: localContext.truncation }),
    ...(countLine === undefined ? {} : { indexCountLine: countLine }),
    ...(p.devil === true ? { devil: true } : {}),
    ...(atMs === undefined
      ? {}
      : {
          pointInTime: {
            atMs,
            zone: gatewayZone(),
            searched: searchedFacts,
            fallbackHistoryStartMs: countDb === undefined ? null : earliestHistoryMs(countDb),
          },
        }),
    // Resolved here rather than at gateway boot so an edit to the active profile's toml is
    // picked up with no restart (D3). No logger: the boot-time resolution in
    // `platform/assemble.ts` owns the warning — warning on every turn would be noise.
    persona: resolvePersona(p.paths.configDir),
    ...(p.notifyGasLimit === undefined ? {} : { notifyGasLimit: p.notifyGasLimit }),
  });

  if (result.fallbackFromLocalRouter !== undefined) {
    partial.fallbackFromLocalRouter = result.fallbackFromLocalRouter;
  }
  if (result.stepBudgetExhausted !== undefined) {
    partial.stepBudgetExhausted = result.stepBudgetExhausted;
  }
  if (result.modelMeta !== undefined) {
    partial.modelRoute = {
      provider: result.modelMeta.provider,
      model: result.modelMeta.modelUsed,
      isLocal: result.modelMeta.isLocal,
    };
  }
  partial.route = conversationalExplainRoute(result.toolless, localContext);

  if (atMs === undefined) {
    await persistConversationTurn(p.sessionMemoryStore, sessionId, p.input, result.reply);
  }

  return {
    reply: result.reply,
    ...(result.modelMeta === undefined ? {} : { modelMeta: result.modelMeta }),
    // Echoed so a client can tell a gateway that honoured `at` from an older one that ignored it.
    ...(atMs === undefined ? {} : { asOfMs: atMs }),
  };
}

function shouldBuildLocalContext(p: RunAskParams): boolean {
  if (p.llmRouter === undefined) {
    return false;
  }
  if (p.conversationalAgent === undefined) {
    return true;
  }
  return p.llmRouter.prefersLocal();
}

function shouldAnswerFromLocalIndexedContext(p: RunAskParams): boolean {
  return (
    p.llmRouter?.prefersLocal() === true &&
    /\b(local indexed|indexed nimbus|nimbus github context|indexed github context)\b/i.test(p.input)
  );
}
/**
 * The ONE place an ask turn builds its dispatching `ToolExecutor` — used by the plan path and, on
 * an owner turn, by the user-MCP agent tools — so the two cannot drift apart on consent, egress,
 * delegation or policy. Consent is bound to THIS turn's client, so an I42 prompt reaches the
 * session that asked. Delegation (I20) is passed for the plan path; the executor itself never
 * consults it for a user-MCP type (I42).
 */
function buildAskExecutor(p: RunAskParams): ToolExecutor {
  return newTurnExecutor(p, p.delegation);
}

/**
 * The one place a turn constructs its `ToolExecutor`. Only `delegation` and `beforeState` vary
 * between the ask executor (`p.delegation`, no runner) and the connector-write door's (`undefined`,
 * the before-state runner); consent, audit, dispatcher, egress, policy and preview credential are
 * the same arguments for both, so they cannot drift.
 */
function newTurnExecutor(
  p: ExecutorBuildParams,
  delegation: ExecutorDelegationDep | undefined,
  extras: ToolExecutorExtras = {},
): ToolExecutor {
  return newExecutorOnChannel(
    p,
    bindConsentChannel(p.consentCoordinator, p.clientId),
    delegation,
    extras,
    p.localIndex,
  );
}

/**
 * The shared construction behind {@link newTurnExecutor} and the unattended workflow executor: the
 * same dispatcher, egress sink, policy and preview credential, on the consent channel the caller
 * names. Everything but the channel comes from the same arguments, so the two cannot drift.
 */
function newExecutorOnChannel(
  p: Omit<ExecutorBuildParams, "clientId" | "consentCoordinator" | "localIndex">,
  consent: ConsentChannel,
  delegation: ExecutorDelegationDep | undefined,
  extras: ToolExecutorExtras,
  audit: AuditSink,
): ToolExecutor {
  // I29: every real connector dispatch routes through this executor, so it carries the egress sink
  // (append-before-dispatch). A connector tool call (read OR write) is an outbound event and is
  // ledgered; a query answered purely from the local index never reaches here, so it adds 0 rows.
  // `p.egressSink` is REQUIRED (see the doc comment on `RunAskParams.egressSink`) — this used to
  // silently fall back to `NULL_EGRESS_SINK` whenever `p.localIndex.getDatabase` wasn't a function;
  // that fallback is gone, so a caller can no longer get a no-op sink without saying so.
  return new ToolExecutor(
    consent,
    audit,
    p.dispatcher,
    delegation,
    p.egressSink,
    p.policyHitl ?? NO_POLICY_OVERLAY,
    p.previewCredentialFor,
    // I15 (AD5b): EVERY turn executor carries the reader (ask, model write door, agent door, both
    // workflow executors), so none can prompt for an `mcp_*` call without the write directories.
    p.userMcpWriteGrants === undefined
      ? extras
      : { ...extras, userMcpWriteGrants: p.userMcpWriteGrants },
  );
}

/**
 * The connector-write door's executor: {@link buildAskExecutor}'s shape with NO delegation (I20),
 * so a model-requested write is only ever approved by the local owner — the first of two layers;
 * the second is the `origin: "model"` every door action carries. With the MCP act door's
 * ({@link buildAgentWriteExecutor}) and the workflow write executor's it is one of the only
 * executors that carry the before-state runner (spec § 5.4, D40(b)), so only a door's prompt reads
 * a write's current state. It is a one-line call of the shared door maker.
 */
export function buildModelWriteExecutor(p: ModelWriteExecutorParams): ToolExecutor {
  return newDoorExecutor(p, bindConsentChannel(p.consentCoordinator, p.clientId), p.localIndex);
}

/** What the model door builds its executor from: the turn's shared arguments. */
export type ModelWriteExecutorParams = Omit<ExecutorBuildParams, "localIndex"> &
  Pick<RunAskParams, "beforeStateRows" | "getTribalKbConfig"> & {
    /** The audit sink (production: the turn's `LocalIndex`). */
    readonly localIndex: AuditSink;
  };

/**
 * What the MCP act door (Phase 28 AD1) builds its executor from, per accept: the ACCEPTING
 * session's client and consent coordinator, the wiring's dispatcher, egress sink, audit sink and
 * policy, and the KB accessor the guards read. `getTribalKbConfig` is REQUIRED: an absent KB config
 * would let the KB-child guards pass (fail open).
 */
export type AgentWriteExecutorParams = Omit<ExecutorBuildParams, "localIndex"> &
  Pick<RunAskParams, "beforeStateRows" | "getTribalKbConfig"> & {
    readonly audit: AuditSink;
  };

/**
 * The MCP act door's executor (static D39(e)): the SAME door maker as {@link buildModelWriteExecutor}
 * (no delegation, the before-state runner), so the two doors cannot drift. The action it runs
 * carries `origin: "agent"` and the gateway-set proposer (`ipc/capture-rpc.ts`).
 *
 * The census in `i55-standing-rule.test.ts` (I55, "the model door and the ask turn have no
 * standing rules") slices this file by function ORDER, from `buildModelWriteExecutor` to
 * `buildWorkflowWriteExecutor`: keep both where they are, with these builders between them.
 */
export function buildAgentWriteExecutor(p: AgentWriteExecutorParams): ToolExecutor {
  return newDoorExecutor(p, bindConsentChannel(p.consentCoordinator, p.clientId), p.audit);
}

/** What the owner's post-mortem push builds its executor from (Phase 10 IC7a): the shared turn arguments. */
export type OwnerPushExecutorParams = Omit<ExecutorBuildParams, "localIndex"> & {
  readonly audit: AuditSink;
};

/**
 * The owner's own push executor (Phase 10 IC7a, D-IC-3): NOT a door. No delegation (I20), EMPTY extras (no
 * before-state runner, no standing rules, never unattended), on THIS connection's consent channel, so
 * the owner's `nimbus incident postmortem --push` is asked at the terminal that ran it and nobody else can
 * answer. The action it runs carries no `origin`, no `proposer`, no `provenance` and the incident link.
 * Its callers are `ipc/postmortem-rpc.ts` (IC7a, the post-mortem push) and `ipc/incident-update-rpc.ts`
 * (IC9b, the owner's incident update post) (static D39(e)). It sits between the two door builders and
 * `buildWorkflowWriteExecutor` so the I55 census slice covers it: it can never carry a standing rule.
 */
export function buildOwnerPushExecutor(p: OwnerPushExecutorParams): ToolExecutor {
  return newExecutorOnChannel(
    p,
    bindConsentChannel(p.consentCoordinator, p.clientId),
    undefined,
    {},
    p.audit,
  );
}

/**
 * The ONE place a connector-write door executor is made (static D40(b)): no delegation (I20) and
 * the before-state runner, with NO `readsEveryOrigin` (it reads for an outside origin only) and NO
 * standing-rule dependencies (I55). The model door and the MCP act door are one-line calls of it.
 */
function newDoorExecutor(
  p: Omit<ExecutorBuildParams, "clientId" | "consentCoordinator" | "localIndex"> &
    Pick<RunAskParams, "beforeStateRows" | "getTribalKbConfig">,
  consent: ConsentChannel,
  audit: AuditSink,
): ToolExecutor {
  return newExecutorOnChannel(
    p,
    consent,
    undefined,
    {
      beforeState: createBeforeStateRunner({
        ...(p.beforeStateRows === undefined ? {} : { rows: p.beforeStateRows }),
        // B3 (R11): the KB-child guards read the tribal KB destinations, snapshotted per read.
        guardContext: () => ({ kb: p.getTribalKbConfig() }),
      }),
    },
    audit,
  );
}

/** What a workflow run needs to build its write executor: the ask turn's shared executor arguments. */
export type WorkflowWriteExecutorParams = ExecutorBuildParams &
  Pick<RunAskParams, "beforeStateRows" | "getTribalKbConfig"> & {
    /** The LIVE enforced policy (I22); absent = standing approvals are locked off (fail closed). */
    readonly enforcedPolicy?: (() => EnforcedPolicy | undefined) | undefined;
    /** Test seam: the I55 check's clock. */
    readonly standingNow?: () => number;
  };

/**
 * The workflow write step's executor (Phase 10 SA2): {@link buildModelWriteExecutor}'s shape for
 * the owner's OWN saved workflow. Consent is bound to the run's client, no delegation (only the
 * owner approves a workflow write, I20), and the before-state runner, so a row's guard runs and the
 * owner sees the current state beside the new values. It is the second (and last) place a
 * before-state runner is built (static D40(b): the door maker's is the other). It offers nothing to the model: the actions come
 * from the owner's stored steps, never from model output. It is also the ONLY executor given the
 * standing-rule check's dependencies (I55, static D44(e)): every other executor has none and so
 * can never approve an action by a rule.
 */
export function buildWorkflowWriteExecutor(p: WorkflowWriteExecutorParams): ToolExecutor {
  return newWorkflowWriteExecutor(p, bindConsentChannel(p.consentCoordinator, p.clientId), false);
}

/** What a scheduled run needs: {@link WorkflowWriteExecutorParams} without a client to ask. */
export type UnattendedWorkflowWriteExecutorParams = Omit<
  WorkflowWriteExecutorParams,
  "clientId" | "consentCoordinator"
>;

/**
 * The scheduler's executor (Phase 10 SA4, static D44(d)): the workflow write executor with no one
 * to ask. Its consent channel denies every request without asking anyone (defence in depth: the
 * executor never reaches it, since an `unattended` executor refuses a write no standing rule covers
 * before it would ask), it has no delegation, and it takes no client id and no consent coordinator.
 * Called only from `gateway-main.ts`, which hands the scheduler a factory.
 */
export function buildUnattendedWorkflowWriteExecutor(
  p: UnattendedWorkflowWriteExecutorParams,
): ToolExecutor {
  return newWorkflowWriteExecutor(p, NEVER_ASKED_CONSENT, true);
}

/** What the IaC drift check's executor is built from: the shared arguments, with no client and no consent. */
export type IacDriftExecutorParams = Omit<ExecutorBuildParams, "clientId" | "consentCoordinator">;

/**
 * The IaC drift check's executor (Phase 10 IaC drift D2, OR-DRIFT-1, static D42(h)): the ONE executor
 * that may run `checkTerraformDrift`, the read-only plan and show of an approved Terraform workdir. Its
 * consent channel denies every request without asking anyone (nothing in a drift check is ever asked),
 * it has no delegation, no before-state runner and no standing rules, and it takes no client id. Called
 * only from `gateway-main.ts`, which hands it to the drift runner (`iac-drift/drift-runner.ts`).
 */
export function buildIacDriftExecutor(p: IacDriftExecutorParams): ToolExecutor {
  return newExecutorOnChannel(
    p,
    NEVER_ASKED_CONSENT,
    undefined,
    { driftCheck: true },
    p.localIndex,
  );
}

/** A consent channel that is never answered by a person: every request is denied, nobody is asked. */
const NEVER_ASKED_CONSENT: ConsentChannel = {
  requestApproval: () => Promise.resolve({ approved: false, answerSource: "none" }),
};

/**
 * The ONE place a workflow write executor is made, and so the one `standingRules:` and the one
 * `unattended:` value in this file (static D44(e) and D44(d)): the attended and the unattended
 * builder are one-line calls of it, so they cannot drift on the before-state runner, the
 * standing-rule dependencies or the policy.
 */
function newWorkflowWriteExecutor(
  p: UnattendedWorkflowWriteExecutorParams,
  consent: ConsentChannel,
  unattended: boolean,
): ToolExecutor {
  return newExecutorOnChannel(
    p,
    consent,
    undefined,
    {
      beforeState: createBeforeStateRunner({
        readsEveryOrigin: true,
        ...(p.beforeStateRows === undefined ? {} : { rows: p.beforeStateRows }),
        guardContext: () => ({ kb: p.getTribalKbConfig() }),
      }),
      standingRules: createStandingRuleDeps({
        db: p.localIndex.getDatabase(),
        enforcedPolicy: p.enforcedPolicy,
        getTribalKbConfig: p.getTribalKbConfig,
        ...(p.standingNow === undefined ? {} : { now: p.standingNow }),
      }),
      unattended,
    },
    p.localIndex,
  );
}

/**
 * What the incident engine's remediation builds its executor from (Phase 10 IC5a, I57 (b)): the shared
 * executor arguments, the before-state rows and KB accessor the guards read, and the observer told what a
 * reversible row's reader captured. `consentCoordinator` is the coordinator the CALLER already wrapped to
 * accept a human answer only.
 */
export type RemediationExecutorParams = ExecutorBuildParams &
  Pick<RunAskParams, "beforeStateRows" | "getTribalKbConfig"> & {
    readonly onCaptured: (
      action: PlannedAction,
      captured: Readonly<Record<string, string>>,
    ) => void;
    /** Phase 17: the executor is built for a dry run, so it may run `readBeforeOnly` (static D46(c)). */
    readonly dryRun?: boolean;
  };

/**
 * The incident remediation executor (static D46(c), D40(b)): consent bound to the CLI client that asked, NO
 * delegation (I20), the before-state runner reading for every origin (the action carries none, it is the
 * owner's own) with the capture observer, and NO standing-rule dependencies and no unattended flag (I55:
 * an engine proposal is never approved by a rule). Called only from `gateway-main.ts`.
 */
export function buildRemediationExecutor(p: RemediationExecutorParams): ToolExecutor {
  return newRemediationExecutor(p, bindConsentChannel(p.consentCoordinator, p.clientId));
}

/** The ONE place the remediation executor is made; a carrier of the before-state runner (static D40(b)). */
function newRemediationExecutor(
  p: RemediationExecutorParams,
  consent: ConsentChannel,
): ToolExecutor {
  return newExecutorOnChannel(
    p,
    consent,
    undefined,
    {
      beforeState: createBeforeStateRunner({
        readsEveryOrigin: true,
        onCaptured: p.onCaptured,
        ...(p.beforeStateRows === undefined ? {} : { rows: p.beforeStateRows }),
        guardContext: () => ({ kb: p.getTribalKbConfig() }),
      }),
      // Phase 17 remediation dry run: the only executor that may run `readBeforeOnly` (static D46(c)), and
      // only when the call asked for a dry run.
      dryRun: p.dryRun === true,
    },
    p.localIndex,
  );
}

async function runActionsPlan(
  p: RunAskParams,
  actions: PlannedAction[],
): Promise<{ reply: string }> {
  const executor = buildAskExecutor(p);
  const summaries: string[] = [];
  const structured: unknown[] = [];

  for (const action of actions) {
    if (p.stream) {
      p.sendChunk(`Running: ${action.type}…\n`);
    }
    const out = await executor.execute(action);
    if (out.status === "rejected") {
      summaries.push(`Rejected: ${out.reason}`);
      structured.push(out);
      break;
    }
    structured.push(out.result);
    summaries.push(`OK: ${action.type}`);
  }

  const summaryText = formatResultSummary(structured);
  const reply = `${summaries.join("\n")}\n\n${summaryText}`;
  if (p.stream) {
    p.sendChunk(`\n${summaryText}\n`);
  }
  return { reply };
}

function handleReplyPlan(p: RunAskParams, text: string): { reply: string } {
  if (p.stream) {
    p.sendChunk(text);
  }
  return { reply: text };
}

async function dispatchPlan(p: RunAskParams, plan: PlanResult): Promise<{ reply: string }> {
  if (plan.kind === "reply") {
    return handleReplyPlan(p, plan.text);
  }
  return await runActionsPlan(p, plan.actions);
}

/** Why this turn skips the classifier and answers conversationally, or `undefined` when it does not. */
function forcedConversationalReason(p: RunAskParams): string | undefined {
  if (p.devil === true) return "devil mode bypasses the classifier";
  if (p.pointInTimeMs !== undefined) return "point-in-time mode bypasses the classifier";
  // A turn that named a computer-use session must reach the agent that drives it, never a plan.
  if (p.computerSessionId !== undefined) return "a computer-use turn bypasses the classifier";
  return undefined;
}

async function runAskInner(p: RunAskParams, partial: ExplainPartial): Promise<RunAskResult> {
  const indexed = countIndexedItems(p.localIndex);
  const empty = emptyIndexGuidanceIfNeeded(p, isDemo(p), indexed);
  if (empty !== undefined) {
    partial.classifier = { called: false, reason: "index is empty" };
    partial.route = { kind: "empty_index" };
    return empty;
  }

  // Two modes force the conversational route, through ONE helper so they cannot drift (the same lesson
  // as `answerConversationally`): devil's advocate (prose) and a point-in-time question (`--at`, which
  // must never reach plan dispatch or a live connector read).
  //
  // Devil's-advocate mode answers in prose, so it routes conversationally REGARDLESS of intent.
  // Plan dispatch has no argument to make — it executes a plan — so without this the flag would
  // silently do nothing for every query the classifier reads as an action, i.e. for a subset the
  // user cannot predict. The classifier is skipped entirely rather than called and ignored: its
  // verdict cannot change the route here, and it costs an LLM round-trip.
  const forcedReason = forcedConversationalReason(p);
  if (forcedReason !== undefined) {
    partial.classifier = { called: false, reason: forcedReason };
    if (!canUseConversation(p)) {
      // Forcing the route must not fabricate a path: with no agent and no local router there is
      // nothing to converse with, and the existing no-LLM error is the honest answer.
      throw new GatewayAgentUnavailableError({ reason: "no_api_key" });
    }
    return await answerConversationally(p, partial);
  }

  const { classified, classifierDestination, classifierSkipReason } =
    await classifyIntentForAskWithLocalFallback(p);
  partial.classifier =
    classifierDestination === undefined
      ? { called: false, reason: classifierSkipReason ?? "classifier produced no destination" }
      : {
          called: true,
          intent: classified.intent,
          confidence: classified.confidence,
          entities: classified.entities,
          destination: classifierDestination,
        };

  const shouldUseConversational =
    shouldAnswerFromLocalIndexedContext(p) ||
    classified.intent === "unknown" ||
    classified.confidence < 0.6;

  if (canUseConversation(p) && shouldUseConversational) {
    return await answerConversationally(p, partial);
  }

  partial.stage = "model";
  const plan = planFromIntent(classified, p.paths);
  partial.route = { kind: "plan_dispatch", plan: describePlan(plan) };
  // Distinct from "model": everything above this line is classification + plan construction, no
  // connector or executor has been touched yet. A throw from `dispatchPlan` onward is a connector
  // or executor failure, not a model failure, and must be reported as such (fix wave finding
  // "IMPORTANT 3").
  partial.stage = "dispatch";
  return await dispatchPlan(p, plan);
}

/**
 * On a demo gateway, every `no_api_key` refusal — whichever route raised it (the classifier, the
 * conversational turn, or `--devil`'s own guard) — is re-raised as the demo variant of the no-LLM
 * guidance. Done HERE, at the one exit every ask client shares, rather than in any client: the
 * CLI's `ask`, the REPL, the TUI (`engine.askStream`) and `nimbus prove "<q>"` all reach `runAsk`,
 * and a per-client swap had already missed three of those four.
 */
function demoAwareAskError(p: RunAskParams, e: unknown): unknown {
  if (isDemo(p) && e instanceof GatewayAgentUnavailableError && e.reason === "no_api_key") {
    return new GatewayAgentUnavailableError({ reason: "no_api_key", demo: true });
  }
  return e;
}

/**
 * Records this call's wall-clock duration for telemetry. Best-effort exactly like
 * {@link recordExplainSafely}: a recorder failure must never change what the caller receives or
 * throws.
 */
function recordLatencySafely(p: RunAskParams, startedAt: number): void {
  if (p.agentLatencyRecorder === undefined) {
    return;
  }
  try {
    p.agentLatencyRecorder.record(Date.now() - startedAt);
  } catch (e) {
    runAskLog.warn(
      { err: e },
      "failed to record agent-invocation latency; the answer is unaffected",
    );
  }
}

export async function runAsk(p: RunAskParams): Promise<RunAskResult> {
  const startedAt = Date.now();
  const partial: ExplainPartial = { stage: "classification" };
  try {
    const out = await runAskInner(p, partial);
    recordExplainSafely(p, partial, startedAt, undefined);
    recordLatencySafely(p, startedAt);
    return out;
  } catch (error) {
    const e = demoAwareAskError(p, error);
    recordExplainSafely(p, partial, startedAt, e);
    recordLatencySafely(p, startedAt);
    throw e;
  }
}

/** Test seam: `buildLocalIndexedContext` is module-private and has no other entry point. */
export const buildLocalIndexedContextForTest = buildLocalIndexedContext;
