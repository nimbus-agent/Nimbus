/** Shared vocabulary of the MCP capture sink (spec 2026-10-11, invariant I28). */

export const CAPTURE_KINDS = ["note", "decision", "term", "link", "action"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];
export type NativeCaptureKind = Exclude<CaptureKind, "action">;

/** What `[mcp_sink] kinds` defaults to: enabling the sink never enables the act door (spec § 5). */
export const DEFAULT_CAPTURE_KINDS = ["note", "decision", "term", "link"] as const;

export function isCaptureKind(v: unknown): v is CaptureKind {
  return typeof v === "string" && (CAPTURE_KINDS as readonly string[]).includes(v);
}

/** The kinds this gateway version accepts on submit: all five since PR 3. */
export const SUBMITTABLE_KINDS: ReadonlySet<CaptureKind> = new Set<CaptureKind>(CAPTURE_KINDS);

export const CAPTURE_STATES = [
  "live",
  "proposed",
  "accepted",
  "rejected",
  "revoked",
  "executing",
  "executed",
  "failed",
  "expired",
] as const;
export type CaptureState = (typeof CAPTURE_STATES)[number];

export function isCaptureState(v: unknown): v is CaptureState {
  return typeof v === "string" && (CAPTURE_STATES as readonly string[]).includes(v);
}

export type CaptureErrorCode =
  | "ERR_CAPTURE_DISABLED"
  | "ERR_CAPTURE_FORBIDDEN_CLIENT"
  | "ERR_CAPTURE_RATE_LIMITED"
  | "ERR_CAPTURE_KIND_NOT_ALLOWED"
  | "ERR_CAPTURE_INVALID"
  | "ERR_CAPTURE_UNKNOWN_ITEM"
  | "ERR_CAPTURE_QUEUE_FULL"
  | "ERR_CAPTURE_NOT_FOUND"
  | "ERR_CAPTURE_STATE"
  | "ERR_CAPTURE_SUPERSEDED"
  | "ERR_CAPTURE_LINK_UNRESOLVED"
  | "ERR_CAPTURE_ACTION_NOT_PROPOSABLE"
  | "ERR_CAPTURE_ACTION_REFUSED"
  | "ERR_CAPTURE_CONNECTOR_UNCONFIGURED"
  | "ERR_CAPTURE_EXPIRED"
  | "ERR_AGENT_TOOL_SUSPENDED";

export class CaptureError extends Error {
  constructor(
    readonly code: CaptureErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "CaptureError";
  }
}

export interface NotePayload {
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly relatesTo: readonly string[];
}

export interface CaptureRow {
  readonly id: string;
  readonly kind: CaptureKind;
  readonly state: CaptureState;
  readonly itemId: string | null;
  readonly payloadJson: string | null;
  readonly payloadBytes: number;
  readonly clientLabel: string | null;
  readonly sessionId: string;
  readonly nativeRef: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
  readonly expiresAt: number | null;
  readonly outcomeRef: string | null;
  readonly errorCode: string | null;
  /**
   * Agent door (AD3a-2a): true on an action proposal queued under the deprecation window, i.e. one
   * the earlier act door accepted that the owner's per-door list would not (V97 `legacy`).
   */
  readonly agentDoorLegacy: boolean;
}

export const LINK_RELATIONS = [
  "relates_to",
  "fixes",
  "caused_by",
  "supersedes",
  "documents",
] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

export interface DecisionPayload {
  readonly statement: string;
  readonly rationale: string | null;
  readonly alternatives: readonly string[];
  readonly decidedAt: number;
  readonly evidence: readonly string[];
}

export interface TermPayload {
  readonly term: string;
  readonly termKey: string;
  readonly definition: string;
  readonly synonyms: readonly string[];
}

export interface LinkPayload {
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly relation: LinkRelation;
  readonly note: string | null;
}

export type ValidatedCapture =
  | { readonly kind: "note"; readonly payload: NotePayload }
  | { readonly kind: "decision"; readonly payload: DecisionPayload }
  | { readonly kind: "term"; readonly payload: TermPayload }
  | { readonly kind: "link"; readonly payload: LinkPayload }
  | { readonly kind: "action"; readonly payload: ActionPayload };

export type NativeValidatedCapture = Exclude<ValidatedCapture, { readonly kind: "action" }>;

/** Stored on a `failed` action row — a classified code, never an error message (spec § 8). */
export const ACTION_ERROR_CODES = [
  "ERR_ACTION_TIMEOUT",
  "ERR_ACTION_TOOL_NOT_FOUND",
  "ERR_ACTION_DISPATCH",
  "ERR_ACTION_INTERRUPTED",
] as const;
export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

/**
 * Stored on a `rejected` action row (V97 allows a code there): why the executor refused, as a fixed
 * code, never the reason text (which may name the owner's data). A plain decline, a mistyped
 * confirmation and a non-human answer store no code. Each fits the V97 `length(error_code) <= 64`.
 */
export const ACTION_REJECT_CODES = [
  "ERR_AGENT_TOOL_SUSPENDED",
  "ERR_ACTION_GUARD_REFUSED",
  "ERR_ACTION_BEFORE_STATE_UNREADABLE",
  "ERR_ACTION_PREPARE_REFUSED",
  "ERR_ACTION_CREDENTIAL_UNVERIFIED",
] as const;
export type ActionRejectCode = (typeof ACTION_REJECT_CODES)[number];

export interface ActionPayload {
  readonly actionType: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly summary: string;
}

/**
 * The sink's view of a proposability verdict. Structural on purpose: `mcp-sink/` may not import
 * `connectors/` (D32(f)), so `connectors/proposable-actions.ts`'s richer type is assigned to this.
 */
export type ActionVerdict =
  | {
      readonly kind: "proposable";
      /**
       * Why it is proposable. NEVER absent: the gate refuses a proposable verdict with no basis
       * (`agent_no_basis`), so a classifier that forgets one fails closed.
       */
      readonly basis: ActionBasis;
      /**
       * Set by the door runtime for an `approved` verdict whose row is a bound row (a commit, an
       * apply): only such a proposal may exceed the ordinary payload cap, up to the validator's
       * structural bound.
       */
      readonly boundInput?: true;
    }
  /**
   * An approved tool whose listed definition changed (AD3a-2a, D-AD-9): refused with
   * `ERR_AGENT_TOOL_SUSPENDED` until the owner approves it again by name. Never a legacy case.
   */
  | { readonly kind: "suspended" }
  | { readonly kind: "denied"; readonly class: string }
  | { readonly kind: "unknown" };

/**
 * Why a proposable action is proposable. `approved`: the owner approved the tool for agents by name
 * and every other condition holds. `legacy_unapproved` / `legacy_mail_send` / `legacy_user_mcp`:
 * accepted for now only because the earlier act door accepted it (the deprecation window, OR-AD-9;
 * `legacy_user_mcp` is a tool of a `--model` server the owner has not approved for agents by name);
 * stored `legacy = 1`, counted and warned about.
 */
export type ActionBasis = "approved" | "legacy_unapproved" | "legacy_mail_send" | "legacy_user_mcp";

/** The fixed class of a proposable verdict that names no basis. */
export const NO_BASIS_CLASS = "agent_no_basis";

/** True for the three deprecation-window bases. */
export function isLegacyBasis(basis: ActionBasis | undefined): boolean {
  return (
    basis === "legacy_unapproved" || basis === "legacy_mail_send" || basis === "legacy_user_mcp"
  );
}

/**
 * Where a proposer label came from, for every proposal today: the connection's own claim. The
 * one producer of the value (AD4); the owner-written kit config is AD7's second source.
 */
export const CAPTURE_LABEL_SOURCE: "declared" | "kit" = "declared";

export interface ActionProvenance {
  /**
   * The basis the approval-time verdict gave (AD3a-2a): what the act wiring routes and vetoes by.
   * Present on every proposal the gate accepts since AD5a; optional only so a stored or injected
   * provenance without one still types (the executor treats it as no per-door rule).
   */
  readonly basis?: ActionBasis;
  readonly captureId: string;
  readonly clientLabel: string | null;
  /** Where {@link ActionProvenance.clientLabel} came from; copied to the executor's proposer (AD4). */
  readonly labelSource: "declared" | "kit";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly summary: string;
}

export type ActExecuteOutcome =
  | { readonly status: "ok"; readonly result: unknown }
  | {
      readonly status: "rejected";
      readonly reason?: string;
      /** A fixed code for a refusal the agent may be told about; absent for a plain decline. */
      readonly code?: ActionRejectCode;
    };

/** Built per accept by `ipc/capture-rpc.ts` (spec § 8): the only path from the sink to a connector. */
export interface ActDeps {
  /**
   * True when the executor's answer can only come from a person at a terminal or the desktop (the
   * consent wrapper turns every other answer into a decline). An `approved`-basis action is accepted
   * only when this is true (AD3a-2a, R-6): the raw `captures.accept` RPC never sets it.
   */
  readonly humanOnly?: boolean;
  execute(
    actionType: string,
    input: Readonly<Record<string, unknown>>,
    provenance: ActionProvenance,
  ): Promise<ActExecuteOutcome>;
}

/**
 * One action type as `capture.describe` reports it to an outside agent (Phase 28 AD3a-2b, D-AD-10).
 * Every string is fixed gateway text, except the `description` and `inputSchema` of an `approved`
 * type, which are the model door's own (the connector's text closer-escaped and delimited, the
 * schema rebuilt from a structural allowlist, the gateway's bound fields removed).
 *
 *   approved       the owner approved it for agents and its listed definition passed, in this call,
 *                  the check a submit runs; the summary mode carries no description or schema
 *   legacy         accepted for now only under the deprecation window: the fixed deprecation line,
 *                  never a schema
 *   suspended      the approved definition changed, or the approval is already suspended
 *   unavailable    approved, but not describable now (not configured, not listed, drifted, ...)
 *   undescribed    a type cut from a reply that was full (ask for fewer types)
 *   not_proposable the door would refuse the type, with the class submit also names
 *
 * It never carries a definition hash or a prefix of one, an approval date, an owner-side reason, a
 * credential or a server address.
 */
export type ActionDescription = { readonly actionType: string } & (
  | {
      readonly state: "approved";
      /** A first-party write's wave; `null` for a tool of a user-registered MCP server (no waves). */
      readonly wave: 2 | 3 | 4 | null;
      /** The owner types the confirm text to approve it (every Wave 4 write). */
      readonly typedConfirm: boolean;
      /** The gateway reads and pins part of the input itself (a commit, an apply). */
      readonly bound: boolean;
      readonly description?: string;
      readonly inputSchema?: Record<string, unknown>;
    }
  | { readonly state: "legacy"; readonly deprecation: string }
  | {
      readonly state: "suspended" | "unavailable" | "undescribed" | "not_proposable";
      readonly reason: string;
    }
);

/** The reply of `capture.describe`: in request order, cut at the byte cap with `truncated`. */
export interface DescribeReply {
  readonly actions: readonly ActionDescription[];
  readonly truncated: boolean;
}
