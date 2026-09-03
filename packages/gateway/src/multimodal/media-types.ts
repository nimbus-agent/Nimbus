/**
 * Shared vocabulary for the multimodal understanding pass (spec § 3.1).
 *
 * Kept separate from the registry so the gate, the pass and the item mapper can all depend on the
 * types without depending on the registry's data.
 */

export type MediaModality = "image" | "av";

/**
 * Every reason an artifact can be skipped. The pass summary reports counts PER REASON — a bare
 * "understood 42 of 108" is the disclosure failure spec § 8 exists to prevent.
 */
export type SkipReason =
  | "over_byte_cap"
  | "no_local_model"
  | "no_remote_grant"
  | "unresolvable_modality"
  | "fetch_miss"
  | "path_outside_roots"
  | "transcode_failed"
  | "transcribe_failed";

export interface MediaCandidate {
  readonly itemId: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
  readonly modality: MediaModality;
  /** Absolute path for a local artifact; null for a cloud artifact (PR 3). */
  readonly sourcePath: string | null;
  readonly sourceMime: string | null;
  readonly sourceBytes: number | null;
}

export interface UnderstandOutcome {
  readonly text: string;
  readonly model: string;
  /**
   * DERIVED from the provider, never supplied by a caller (spec § 3.4 step 2, invariant I34).
   * Recorded on the derived item so a reader can tell where the understanding came from.
   */
  readonly isLocal: boolean;
  /**
   * Present only for a video that reached frame sampling. Recorded so a reader can tell a video
   * whose frames all failed (`framesCaptioned: 0`) from one that was never sampled at all (both
   * absent) — the body states the same thing in prose (spec § 12.8), and these are the
   * machine-readable half.
   */
  readonly framesSampled?: number;
  readonly framesCaptioned?: number;
}

/**
 * What an understander RETURNS, as opposed to {@link UnderstandOutcome} which is what the gate
 * RECORDS. The gate adds `model` and `isLocal` from the provider — those are derived, never
 * reported by the understander (I34) — and carries the rest through.
 *
 * A structured type rather than `string | UnderstandDetail`: a union leaves a `typeof` narrow at
 * the gate forever, and it makes "this understander forgot to report its counts" and "this
 * understander has no counts to report" the same value. Total, the compiler names every implementer
 * when a field is added. There are three implementers and one caller, all inside `multimodal/`, so
 * there is no compatibility argument for the looser type.
 */
export interface UnderstandDetail {
  readonly text: string;
  readonly framesSampled?: number;
  readonly framesCaptioned?: number;
}

/**
 * Bumped when a better model or a changed prompt means existing understanding should be redone.
 *
 * It lives in item METADATA and never in an `externalId`: `item` is UNIQUE(service, external_id),
 * so a version in the id would create a second row per artifact per version rather than replacing
 * the first — duplicate FTS hits and duplicate agent context (spec § 4.1).
 */
export const UNDERSTANDING_VERSION = 1;
