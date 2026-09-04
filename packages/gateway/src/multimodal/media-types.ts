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
  | "transcribe_failed"
  | "not_configured"
  | "rate_limited";

/**
 * What an understander is actually handed (spec § 5.4, PR 3). A local artifact resolves to a
 * `path` (unchanged from PR 1/2); a cloud artifact's bytes never touch disk for an image, so that
 * arm carries the bytes themselves instead. `mime` on the bytes arm is the SOURCE mime — a cloud
 * provider's declared content type, not something an understander should trust further than that.
 *
 * AV never produces the `bytes` arm today (`whisper-cli`/`ffmpeg` need a seekable file), but the
 * union exists here, not as two separate parameter types, so the gate and both understanders share
 * one shape rather than each guessing which arm the other side means.
 */
export type MediaSource =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array; readonly mime: string | null };

export interface MediaCandidate {
  readonly itemId: string;
  readonly service: string;
  /** The PROVIDER's own id, read from the column. */
  readonly externalId: string;
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
 * V2 (PR 2): `video_understanding` now carries sampled frame captions alongside the transcript,
 * and `image_understanding` rows exist for the first time. `media-discovery.ts` re-offers any row
 * below this number, so the bump is what makes a PR 1 transcript gain captions on the next pass.
 *
 * It lives in item METADATA and never in an `externalId`: `item` is UNIQUE(service, external_id),
 * so a version in the id would create a second row per artifact per version rather than replacing
 * the first — duplicate FTS hits and duplicate agent context (spec § 4.1).
 */
export const UNDERSTANDING_VERSION = 2;

/**
 * The `AI_V2_CAPABILITIES` member (`policy/types.ts`) an org policy disables to turn this
 * capability off gateway-wide (invariant I22). Exported so a test can pin it against that frozen
 * list rather than repeating the string — a typo here would read as "never disabled".
 */
export const MULTIMODAL_CAPABILITY = "multimodal_input";

/**
 * What bytes an artifact was actually understood from (spec § 16.8, PR 3). `"original"` covers
 * both the local arm (always the real file) and the cloud arm with `preferRenditions` off or a
 * service that has no rendition to offer — Drive and OneDrive always serve the original regardless
 * of that flag, since `cloud-renditions.ts`'s `driveByteUrl`/`onedriveByteUrl` take no rendition
 * argument at all. Only a Photos fetch with `preferRenditions` on ever produces the other two.
 * Recorded on the derived row in BOTH places, mirroring `framesSampled`/`framesCaptioned`: metadata
 * for a later pass to filter on, and a body sentence for a reader to see directly.
 */
export type RenditionMode = "original" | "w2048-h2048" | "dv";
