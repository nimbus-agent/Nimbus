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
  | "ERR_CAPTURE_CONNECTOR_UNCONFIGURED"
  | "ERR_CAPTURE_EXPIRED";

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
  | { readonly kind: "proposable" }
  | { readonly kind: "denied"; readonly class: string }
  | { readonly kind: "unknown" };

export interface ActionProvenance {
  readonly captureId: string;
  readonly clientLabel: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly summary: string;
}

export type ActExecuteOutcome =
  | { readonly status: "ok"; readonly result: unknown }
  | { readonly status: "rejected" };

/** Built per accept by `ipc/capture-rpc.ts` (spec § 8): the only path from the sink to a connector. */
export interface ActDeps {
  execute(
    actionType: string,
    input: Readonly<Record<string, unknown>>,
    provenance: ActionProvenance,
  ): Promise<ActExecuteOutcome>;
}
