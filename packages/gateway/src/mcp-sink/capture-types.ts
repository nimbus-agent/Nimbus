/** Shared vocabulary of the MCP capture sink (spec 2026-10-11, invariant I28). */

export const CAPTURE_KINDS = ["note", "decision", "term", "link"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export function isCaptureKind(v: unknown): v is CaptureKind {
  return typeof v === "string" && (CAPTURE_KINDS as readonly string[]).includes(v);
}

/** The kinds this gateway version accepts on submit: all four since PR 2. */
export const SUBMITTABLE_KINDS: ReadonlySet<CaptureKind> = new Set<CaptureKind>(CAPTURE_KINDS);

export const CAPTURE_STATES = ["live", "proposed", "accepted", "rejected", "revoked"] as const;
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
  | "ERR_CAPTURE_LINK_UNRESOLVED";

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
  | { readonly kind: "link"; readonly payload: LinkPayload };
