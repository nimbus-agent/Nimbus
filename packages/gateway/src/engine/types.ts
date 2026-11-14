import type { BoundWriteCapabilities } from "./bound-write-capabilities.ts";

/** How a workflow run started, as the gateway derived it (never from params). */
/**
 * How a workflow run started, as the gateway derived it. `schedule` is reserved for the gateway's own
 * scheduler (Phase 10 SA4): nothing produces it yet, so until then a standing rule fires only on
 * an owner-started run.
 */
export type WorkflowTrigger = "schedule" | "owner_cli" | "owner_ui";

/**
 * Where an action came from when the owner's own saved workflow built it (Phase 10 SA2, spec § 5.1).
 * Constructed ONLY in `automation/workflow-write-step.ts` (source-pinned), so no IPC, model, act
 * door, ChatOps, LAN or HTTP path can supply one. The audit row records everything here except
 * `fieldSources`, which only the standing-rule check (`engine/standing-rule-step.ts`, I55) reads.
 */
export type WorkflowProvenance = {
  readonly kind: "owner_workflow";
  readonly workflowId: string;
  /** SHA-256 of the canonical JSON of the steps the run loaded. */
  readonly workflowSha256: string;
  readonly stepIndex: number;
  readonly runId: string;
  readonly trigger: WorkflowTrigger;
  /** Per input field: a constant, or the declared query step (by index) and column it came from. */
  readonly fieldSources: Readonly<
    Record<string, "constant" | { readonly query: number; readonly column: string }>
  >;
};

export type PlannedAction = {
  type: string;
  payload?: Record<string, unknown>;
  /**
   * Set only by the gateway's workflow write step, never from IPC, payload or a door. Top level
   * only: a `payload.provenance` means nothing.
   */
  provenance?: WorkflowProvenance;
  /**
   * Set only by the gateway for an action an outside party proposed: `"model"` (the conversational
   * model, I53) or `"agent"` (an MCP client through the act door, I28). It only ever REMOVES
   * delegation (a delegate never approves it, I20) and standing rules (I55), enables the
   * before-state runner and adds a consent line; whether HITL is required stays decided by `type`
   * alone (I3). Top level only: a `payload.origin` means nothing. Read it only through
   * `isOutsideOrigin` (`engine/outside-origin.ts`).
   */
  origin?: "model" | "agent";
  /**
   * Set only by the gateway beside `origin: "agent"`, from the stored capture row (never from IPC, a
   * payload or a door; top level only, the `provenance` pattern). DISPLAY data for the owner's
   * prompt, in an UNVERIFIED block after the verified preview: it never selects the tool, the
   * credential or the confirm text (I3), and nothing in it reaches the connector call.
   */
  proposer?: AgentProposer;
  /**
   * Set only by the gateway beside `origin: "agent"` for a tool of a user-registered MCP server
   * (AD5a, I42): what the owner's prompt shows about the third-party code. DISPLAY data like
   * `proposer`; it never selects the tool or the key (the dispatcher's exact pairing does), and the
   * audit row projects it to the definition hash alone.
   */
  userMcpCall?: UserMcpCallFacts;
};

/**
 * The facts about a user MCP server and tool the approval prompt shows (AD5a, D-6), read by the
 * agent door at the call. `approval` is null for a proposal accepted under the deprecation window;
 * otherwise `description` is the text of the listing entry whose hash was just compared with the
 * owner's approval, so the text shown is the text that was hashed. Every string is the server's or
 * the owner's and is escaped by the renderer; none reaches the connector call.
 */
export type UserMcpCallFacts = {
  readonly serviceId: string;
  readonly tool: string;
  readonly registeredAt: number;
  readonly readPaths: readonly string[];
  readonly netHosts: readonly string[];
  readonly networkNote?: string;
  /** Always empty until AD5b (write grants); rendered so AD5b fills it without touching the prompt. */
  readonly writePaths: readonly string[];
  readonly approval: {
    readonly approvedAt: number;
    readonly definitionSha256: string;
    readonly description: string;
  } | null;
};

/** An outside agent's proposal as the owner's prompt shows it (Phase 28 AD1). Every field is UNVERIFIED. */
export type AgentProposer = {
  door: "agent";
  /** The capture row the proposal waits in (`cap_...`). */
  captureId: string;
  /** The client's declared name, or null. */
  label: string | null;
  /** Where the label came from: the connection's own claim, or the owner-written kit config. */
  labelSource: "declared" | "kit";
  /** The agent's own one-line summary of what it wants. */
  summary: string;
  createdAt: number;
  expiresAt: number;
  /**
   * The gateway's own fixed deprecation text (AD3a-2a), set only when the proposal was accepted
   * under the deprecation window; never the agent's words. Shown as a third line of the block.
   */
  deprecation?: string;
};

export type ActionResult =
  | { status: "ok"; result: unknown }
  | { status: "rejected"; reason: string };

/**
 * A type-to-confirm request (Phase 9.7 D0a): the owner approves a Wave 4 write only by typing
 * `confirmText` exactly. `prompt` already ends with the fixed line telling them what to type.
 */
export interface ConfirmedApprovalRequest {
  prompt: string;
  details?: Record<string, unknown> | undefined;
  actionType?: string | undefined;
  confirmText: string;
}

/**
 * Where an approval answer came from (Phase 10 SA1, spec § 6.1). Client-reported for the owner's
 * prompt: `human` (a person answered), `auto` (`--yes`), `script` (a scripted consent); `unknown`
 * is an older client that sent none; `delegate` and `remote` are set by the gateway for a delegated
 * and a ChatOps answer; `none` is a decision no prompt was shown for.
 */
export type AnswerSource = "human" | "auto" | "script" | "unknown" | "delegate" | "remote" | "none";

/** The answer sources an IPC consent reply may carry (the client-reported subset). */
export const REPORTED_ANSWER_SOURCES = ["human", "auto", "script"] as const;

/** What the approval phase decided: an owner/delegate answer, or (reserved for I55) a standing rule. */
export type ApprovalOutcome =
  | { kind: "approved"; answerSource: AnswerSource }
  | { kind: "rejected"; reason: string; answerSource: AnswerSource }
  | { kind: "standing_approved"; ruleId: string; fireId: string };

/** The owner's answer to a {@link ConfirmedApprovalRequest}: the decision and what they typed. */
export interface ConfirmedApprovalResult {
  approved: boolean;
  typed: string;
  answerSource: AnswerSource;
}

/** The owner's answer to a plain approval request. */
export interface ApprovalAnswer {
  approved: boolean;
  answerSource: AnswerSource;
}

export interface ConsentChannel {
  requestApproval(
    prompt: string,
    details?: Record<string, unknown>,
    actionType?: string,
  ): Promise<ApprovalAnswer>;
  /**
   * Collects a typed confirmation. A channel without it cannot approve a Wave 4 write: the
   * executor denies it (`confirm: unsupported_channel`) and never falls back to
   * `requestApproval`. The channel only carries the text; the comparison with `confirmText` is
   * the executor's alone (static D41).
   */
  requestConfirmedApproval?(req: ConfirmedApprovalRequest): Promise<ConfirmedApprovalResult>;
}

export interface AuditSink {
  recordAudit(entry: {
    actionType: string;
    hitlStatus: "approved" | "rejected" | "not_required" | "standing_approved";
    actionJson: string;
    timestamp: number;
    sessionId?: string;
  }): void;
}

export interface ConnectorDispatcher {
  dispatch(action: PlannedAction): Promise<unknown>;
  /**
   * D2 (I54): the runtime capabilities of a bound IaC row (its settle step and its preflight).
   * Optional and read-only; set only by the production dispatcher built in `connectors/registry.ts`
   * (a test dispatcher sets its own). The gate reaches it ONLY from its preflight and prepare
   * phases, and a bound row whose tag needs it is refused when it is absent.
   */
  readonly boundWriteCapabilities?: BoundWriteCapabilities;
}
