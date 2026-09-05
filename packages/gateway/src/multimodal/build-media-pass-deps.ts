/**
 * Constructs the production dependencies for the understanding pass.
 *
 * Separate from `media-pass.ts` so the pass stays a pure orchestrator over injected seams and can
 * be tested without a whisper binary, an arbiter or a config. This is the one place that knows
 * what the real implementations are.
 *
 * `understanderFor` resolves BOTH modalities: PR 2 adds the vision arm alongside PR 1's transcript
 * arm, so an image or video candidate no longer falls through to `unresolvable_modality` here.
 */
import type { Database } from "bun:sqlite";
import { readFile as fsReadFile } from "node:fs/promises";
import { getValidGoogleAccessToken } from "../auth/google-access-token.ts";
import { getValidMicrosoftAccessToken } from "../auth/microsoft-access-token.ts";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import { recordSyncEgress } from "../egress/sync-egress.ts";
import { wrapLedgeredVlm } from "../egress/vlm-egress.ts";
import { GpuArbiter } from "../llm/gpu-arbiter.ts";
import { vendorApiKeyName } from "../llm/vendor-vault-keys.ts";
import { safeFetchFollowing } from "../util/safe-fetch.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { WhisperSttProvider } from "../voice/stt.ts";
import { createAvUnderstander } from "./frames/av-understander.ts";
import { resolveFfprobeBin } from "./frames/frame-extract.ts";
import type { Understander } from "./media-gate.ts";
import { hasActiveGrant } from "./media-grant-store.ts";
import type { MediaCloudDeps, MediaPassDeps } from "./media-pass.ts";
import type { MediaCandidate, MediaModality, MediaSource, RemoteVlmVendor } from "./media-types.ts";
import { UnsupportedImageFormatError } from "./media-types.ts";
import {
  DEFAULT_FETCH_BUDGET_BYTES,
  DEFAULT_MAX_FRAMES,
  DEFAULT_PREFER_RENDITIONS,
  DEFAULT_VLM_BASE_URL,
  DEFAULT_VLM_MODEL,
} from "./multimodal-config.ts";
import { resolveFfmpegBin } from "./stt/ffmpeg-bin.ts";
import { createLongFormStt } from "./stt/long-form-stt.ts";
import { IMAGE_CAPTION_PROMPT } from "./vlm/caption-prompts.ts";
import { resolveWireMime } from "./vlm/image-mime.ts";
import { createImageUnderstander } from "./vlm/image-understander.ts";
import type { FetchLike } from "./vlm/ollama-vlm.ts";
import { createOllamaVlm } from "./vlm/ollama-vlm.ts";
import { createRemoteVlm } from "./vlm/remote/remote-vlm-shared.ts";

export interface BuildMediaPassDepsInput {
  readonly db: Database;
  readonly roots: readonly string[];
  readonly enabled: boolean;
  readonly capabilityDisabled: boolean;
  readonly scratchDir: string;
  readonly maxBytes?: number;
  /** Shared with the LLM runtime when one exists, so media and generation contend on one lock. */
  readonly gpu?: GpuArbiter;
  readonly whisperBin?: string;
  readonly ffmpegBin?: string;
  /** Wall-clock bound on the whisper call itself. See {@link DEFAULT_TRANSCRIBE_TIMEOUT_MS}. */
  readonly transcribeTimeoutMs?: number;
  readonly vlmBaseUrl?: string;
  readonly vlmModel?: string;
  readonly maxFrames?: number;
  readonly ffprobeBin?: string;
  /**
   * Injected only by tests; production uses the global `fetch`.
   *
   * Typed as `FetchLike` (STRUCTURAL), never `typeof fetch` — Bun's `fetch` carries static
   * members (`preconnect`), so `typeof fetch` rejects a plain test lambda and forces every test
   * double through an `as unknown as` cast that routes around the type checker (see
   * `ollama-vlm.ts`'s `FetchLike`, which exists precisely to avoid that).
   */
  readonly vlmFetch?: FetchLike;
  /** `[multimodal] fetch_budget_bytes` (spec § 16.9). Defaults to {@link DEFAULT_FETCH_BUDGET_BYTES}. */
  readonly fetchBudgetBytes?: number;
  /** `[multimodal] prefer_renditions` (spec § 16.8). Defaults to {@link DEFAULT_PREFER_RENDITIONS}. */
  readonly preferRenditions?: boolean;
  /**
   * The Vault a cloud fetch's bearer token is resolved from (Drive/Photos/OneDrive OAuth).
   * `ipc/server/dispatchers.ts`'s `buildMediaPassDepsInput` forwards `ctx.options.vault` here —
   * the same vault every other vault-consuming dispatcher in that file reads — so production
   * cloud fetch DOES authenticate. Optional on this type only for the many tests in this file that
   * construct `BuildMediaPassDepsInput` directly without a vault: `cloudBearerFor` below fails
   * CLOSED when this is absent, so every bearer-requiring cloud fetch in such a test skips as
   * `not_configured` rather than throwing or guessing a credential — a deliberate, disclosed
   * degradation for a caller that has no vault to give it, not a production gap.
   */
  readonly vault?: NimbusVault;
  /**
   * The label of the client that ASKED for this pass, forwarded into every `sync`-class egress
   * row `buildCloudBytesDeps` appends (`recordSyncEgress`'s `sourceId`). `media.understand` is
   * caller-initiated over IPC — unlike `sync/scheduler.ts`'s own timer-driven runs, which is what
   * an absent `sourceId` on a `sync` row is reserved to mean — so without this, every
   * `media.resolveByteUrl`/`media.fetchBytes` row filed as an unattributed background sync and an
   * auditor could not separate a caller-initiated cloud fetch from a scheduled one.
   *
   * Server-derived ONLY: `ipc/server/dispatchers.ts`'s `tryDispatchMediaRpc` sets this from
   * `ctx.getClientKind(clientId)` — the connection's declared kind, keyed by a server-assigned
   * `clientId` — never from a `media.understand` request body field, which would let one client
   * file its egress under another's name.
   */
  readonly sourceId?: string;
  /**
   * `[multimodal] remote_vlm` (Task 5's `MultimodalConfig.remoteVlm`), `null` when unset — which is
   * every install's state before a remote adapter ships (Task 10) and every install that never
   * opts in after. Threading this through is what lets `buildRemoteFor` check "is a vendor
   * configured" independently of "is this exact artifact granted": neither alone is sufficient
   * (§ 19.3 — a grant with no configured vendor must still resolve LOCAL, never a refusal).
   */
  readonly remoteVlm?: RemoteVlmVendor | null;
  /**
   * `[llm.remote.<vendor>].enabled` for the vendor named by `remoteVlm` above — gate 3 of § 18.1
   * needs BOTH "a vendor is named" (`remoteVlm`) AND "that vendor's OWN opt-in is on" (this field);
   * neither alone is sufficient (§ 18.2). `llm/vendor-vault-keys.ts` deliberately SHARES
   * `openai.api_key` with the embedding runtime, so an install can hold a live key while having
   * never opted OpenAI in for text, let alone for vision — a credential that merely exists must
   * never itself enable sending photos to a vendor.
   *
   * Resolved by `ipc/server/dispatchers.ts`'s `tryDispatchMediaRpc` from `[llm.remote.<vendor>]`,
   * the SAME nimbus.toml the `[multimodal]` section itself lives in, and forwarded here
   * UNCOMBINED with `remoteVlm` — this file, not the dispatcher, is what decides what an absent
   * flag means. Absent or `false`: no remote arm, matching every other config-driven switch in
   * this file's own fail-closed default.
   */
  readonly remoteVlmVendorEnabled?: boolean;
}

/**
 * Resolves a bearer token for the three OAuth-backed cloud services this pass can fetch from.
 * `service` is whatever `MediaCandidate.service` carries — any other value (and every value at all
 * when `vault` is absent) returns `null`, which `cloud-bytes.ts`/`cloud-url-resolver.ts` both treat
 * as `not_configured` and skip the one artifact rather than failing the whole pass.
 *
 * `getValidGoogleAccessToken`/`getValidMicrosoftAccessToken` both THROW when the service has no
 * usable OAuth grant (never configured, revoked, refresh failed) — caught here and folded into the
 * same `null` a missing vault produces, so a caller cannot tell "no vault" from "vault present but
 * unauthenticated" and does not need to: both mean the same thing to the fetch that asked.
 */
async function cloudBearerFor(
  vault: NimbusVault | undefined,
  service: string,
): Promise<string | null> {
  if (vault === undefined) {
    return null;
  }
  try {
    if (service === "google_drive" || service === "google_photos") {
      return await getValidGoogleAccessToken(vault, service);
    }
    if (service === "onedrive") {
      return await getValidMicrosoftAccessToken(vault);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The remote VLM arm's Vault read, mirroring `cloudBearerFor`'s fail-closed shape: no vault means
 * no key, never a guess and never an environment fallback (Non-Negotiable #3). Resolved PER CALL,
 * same as `platform/assemble.ts`'s text-route `apiKey` closures — a key added after boot works
 * with no restart, and `vendorApiKeyName` is the ONE place a vendor's Vault key name is
 * constructed (D11).
 */
export async function vendorApiKey(
  vault: NimbusVault | undefined,
  vendor: RemoteVlmVendor,
): Promise<string | null> {
  if (vault === undefined) {
    return null;
  }
  return vault.get(vendorApiKeyName(vendor));
}

/**
 * The cloud arm's shared collaborators (spec § 16.2–16.6). `fetchFn` is `safeFetchFollowing` —
 * every hop of a redirect re-validated against the private-address/SSRF check, credentials
 * stripped on a cross-origin hop — never a bare `fetch`: `cloud-url-resolver.ts`'s own `fetchFn`
 * docstring describes this as a contract on the type until a caller wires it, and this is that
 * wiring (`cloud-bytes.ts`'s `CloudBytesDeps.fetchFn` is an undocumented bare field, so only the
 * resolver's docstring made the claim). `appendEgress` is the REAL `sync`-class ledger append (I29),
 * and this ONE closure serves TWO of that class's callers: `media-pass.ts` hands it both to
 * `cloud-url-resolver.ts` (one row before the credentialed byte-URL resolve round-trip,
 * `method='media.resolveByteUrl'`) and to `cloud-bytes.ts` (one row per byte-fetch attempt,
 * `method='media.fetchBytes'`). They are the third and fourth callers of `recordSyncEgress`,
 * alongside `sync/scheduler.ts` and `sync/targeted-fetch.ts` (see `docs/SECURITY-INVARIANTS.md`'s
 * I29 entry, which names all four).
 * `sleep` is a real wall-clock delay, used only by `cloud-bytes.ts`'s 429/503 backoff.
 */
function buildCloudBytesDeps(input: BuildMediaPassDepsInput): MediaCloudDeps {
  return {
    bearerFor: (service: string) => cloudBearerFor(input.vault, service),
    fetchFn: (url: string, init: RequestInit) => safeFetchFollowing(url, init),
    // `expectedBytes` is OPTIONAL on the seam and only `cloud-bytes.ts` supplies it: the resolver
    // shares this one closure and its `media.resolveByteUrl` row is a metadata round-trip that
    // transfers no artifact bytes, so it correctly leaves the field absent rather than attaching
    // a size to a request that never carries one.
    appendEgress: (row: { destination: string; method: string; expectedBytes?: number | null }) =>
      recordSyncEgress(input.db, { ...row, now: Date.now(), sourceId: input.sourceId }),
    sleep: (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)),
  };
}

/**
 * The per-artifact byte cap: 250 MiB, ONE value for images and audio/video alike.
 *
 * NOT config-driven, despite what spec § 5.3 proposed: there is no `max_media_bytes` key and no
 * `max_image_bytes` key — neither was built, and `[multimodal]`'s loader accepts neither. The only
 * override is `BuildMediaPassDepsInput.maxBytes`, which nothing in production supplies, so this
 * constant IS the cap on a shipped install. Named here rather than left implicit because
 * `over_byte_cap` skips point at it, and a user told to "raise the cap" needs to know there is no
 * knob to raise (see `docs/cli-reference.md`'s `nimbus media understand` section).
 */
const DEFAULT_MAX_MEDIA_BYTES = 250 * 1024 * 1024;

/**
 * Generous for the same reason as ffmpeg-bin.ts's `DEFAULT_TRANSCODE_TIMEOUT_MS`: a long
 * recording on a slow CPU is legitimate. This bounds a HANG, not slowness.
 */
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Bounds a whisper transcription call by wall clock, WITHOUT touching `WhisperSttProvider` —
 * that provider is shared with the voice subsystem, which has its own (interactive) tolerance for
 * how long to wait. Without a bound here, a wedged `whisper-cli` hangs the whole understanding
 * pass indefinitely: `transcodeToWav` has its own timeout, but nothing bounded the transcription
 * call that follows it.
 *
 * On expiry this REJECTS rather than resolving. `understandArtifact` (media-gate.ts) already wraps
 * `provider.understand()` in a try/catch that turns any rejection into the `transcribe_failed`
 * skip reason and moves on to the next candidate — so rejecting here is what keeps the pass going
 * rather than aborting it, not a special case this function has to implement itself.
 *
 * Unlike `ffmpeg-bin.ts`'s `withProcessTimeout`, this owns no handle to the underlying process —
 * only the injected `transcribe` promise-returning function — so a real whisper-cli process is not
 * killed on expiry, only waited on no longer. Exported (rather than kept private) so a test can
 * exercise the timeout arm directly with a never-resolving fake and a millisecond-scale bound,
 * instead of waiting out {@link DEFAULT_TRANSCRIBE_TIMEOUT_MS} against a real binary.
 */
export function withTranscribeTimeout(
  transcribe: (wavPath: string) => Promise<{ text: string }>,
  timeoutMs: number,
): (wavPath: string) => Promise<{ text: string }> {
  return (wavPath: string) =>
    new Promise<{ text: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`whisper transcription timed out after ${timeoutMs}ms for ${wavPath}`));
      }, timeoutMs);
      transcribe(wavPath).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
}

/**
 * Reads a `MediaSource`'s bytes, mirroring `image-understander.ts`'s inline pattern for the local
 * arm: cloud bytes (PR 3) never touch disk and are taken directly, a local artifact is read here.
 * No exported equivalent existed to reuse (checked before adding this) — a second private copy in
 * the one other caller would have been the third occurrence of the same three-line branch.
 *
 * Exported so both `MediaSource` arms can be exercised directly, without routing a real image
 * through the wrapped remote provider's `describe()` (a real outbound request) just to prove which
 * branch ran.
 */
export async function bytesForSource(source: MediaSource): Promise<Uint8Array> {
  return source.kind === "bytes" ? source.bytes : new Uint8Array(await fsReadFile(source.path));
}

/**
 * The grant half of the remote arm. Returns a provider only when a vendor is configured AND an
 * active grant names it for this artifact — the two independent conditions of § 18.1 steps 3 and 4.
 *
 * `vendor` arrives here ALREADY GATED by `buildMediaPassDeps`'s own gate-3 check (the vendor's
 * `[llm.remote.<vendor>].enabled` opt-in, § 18.2): a configured-but-disabled vendor is passed in
 * as `null`, exactly as if `[multimodal] remote_vlm` were unset, so the `vendor === null` check
 * below covers BOTH "unconfigured" and "configured but its parent opt-in is off" — there is
 * nothing left for this function to check about the parent switch itself.
 *
 * The `Database` read lives here rather than in the gate so `media-gate.ts` never touches SQL and
 * D27(b) holds without an exemption for it.
 *
 * The remote provider and its `Understander` adapter are built ONCE, here, when `vendor` is
 * non-null — not inside the returned per-candidate closure — so one provider instance (and one
 * egress-ledger wrapper) serves every granted artifact in the pass, mirroring how `vlm`/
 * `imageUnderstander` are each built once in `buildMediaPassDeps` below.
 */
function buildRemoteFor(
  input: BuildMediaPassDepsInput,
  vendor: RemoteVlmVendor | null,
): ((candidate: MediaCandidate) => Understander | undefined) | undefined {
  if (vendor === null) return undefined;

  // THE ONLY production site that may name `createRemoteVlm` (static rule D27(a)) -- the same file
  // that already holds `createOllamaVlm` under D22(g), so one wiring site carries both and the two
  // rules cannot point at different files for the same class of object.
  const remoteProvider = wrapLedgeredVlm(
    input.db,
    createRemoteVlm({ vendor, apiKey: () => vendorApiKey(input.vault, vendor) }),
  );

  const remoteUnderstander: Understander = {
    // DERIVED from the provider, never restated (I34).
    isLocal: remoteProvider.isLocal,
    model: `${vendor}/${remoteProvider.model}`,
    isAvailable: () => remoteProvider.isAvailable(),
    understand: async (source) => {
      const bytes = await bytesForSource(source);
      const mime = resolveWireMime(bytes, source.kind === "bytes" ? source.mime : null);
      if (mime === null) {
        throw new UnsupportedImageFormatError("not a JPEG, PNG, WebP or GIF");
      }
      const { text } = await remoteProvider.describe({
        bytes,
        prompt: IMAGE_CAPTION_PROMPT,
        mimeType: mime,
        egressMethod: "multimodal.vlm.image",
      });
      return { text };
    },
  };

  return (candidate: MediaCandidate): Understander | undefined => {
    if (candidate.modality !== "image") return undefined; // § 19.4: AV is local-only, always.
    if (
      !hasActiveGrant(input.db, {
        itemId: candidate.itemId,
        modality: "image",
        modelVendor: vendor,
      })
    ) {
      return undefined;
    }
    return remoteUnderstander;
  };
}

export type BuiltMediaPassDeps = Omit<
  MediaPassDeps,
  "limit" | "service" | "modality" | "sinceMs" | "afterItemId"
>;

export function buildMediaPassDeps(input: BuildMediaPassDepsInput): BuiltMediaPassDeps {
  const whisper = new WhisperSttProvider(
    input.whisperBin === undefined ? {} : { whisperBin: input.whisperBin },
  );
  const stt = createLongFormStt({
    transcribe: withTranscribeTimeout(
      (wavPath: string) => whisper.transcribe(wavPath),
      input.transcribeTimeoutMs ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS,
    ),
    isAvailable: () => whisper.isAvailable(),
    ffmpegBin: resolveFfmpegBin(input.ffmpegBin),
    scratchDir: input.scratchDir,
    model: "whisper-cli",
  });

  const arbiter = input.gpu ?? new GpuArbiter();

  // THE ONLY production site that may name `createOllamaVlm` or `wrapLedgeredVlm` (static rule
  // D22(g)). The constructor sits INSIDE the wrapper's argument list so an unwrapped provider is
  // not representable here: the audit checks that association, not merely that both names appear.
  const vlm = wrapLedgeredVlm(
    input.db,
    createOllamaVlm({
      baseUrl: input.vlmBaseUrl ?? DEFAULT_VLM_BASE_URL,
      model: input.vlmModel ?? DEFAULT_VLM_MODEL,
      ...(input.vlmFetch === undefined ? {} : { fetchImpl: input.vlmFetch }),
    }),
  );

  const imageUnderstander = createImageUnderstander({ vlm });
  const avUnderstander = createAvUnderstander({
    stt,
    vlm,
    maxFrames: input.maxFrames ?? DEFAULT_MAX_FRAMES,
    ffmpegBin: resolveFfmpegBin(input.ffmpegBin),
    ffprobeBin: resolveFfprobeBin(input.ffprobeBin),
  });

  // Gate 3 of § 18.1 (spec § 18.2): `[multimodal] remote_vlm` naming a vendor is not enough on its
  // own — that vendor's OWN `[llm.remote.<vendor>].enabled` opt-in must also be on, or a
  // credential that merely exists (`openai.api_key` is shared with the embedding runtime) would
  // silently enable sending images to a vendor nobody separately opted into for vision. Computed
  // ONCE so both consumers below — `remoteFor` and `MediaPassDeps.remoteVendor` (read by
  // `media-discovery.ts`'s re-offer query) — see the same answer: a disabled parent must mean no
  // remote arm exists AT ALL, not a refusal deferred to `describe()`.
  const remoteVlm =
    input.remoteVlm != null && input.remoteVlmVendorEnabled === true ? input.remoteVlm : null;

  return {
    db: input.db,
    roots: input.roots,
    maxBytes: input.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES,
    nowMs: () => Date.now(),
    passId: "default",
    scratchDir: input.scratchDir,
    fetchBudgetBytes: input.fetchBudgetBytes ?? DEFAULT_FETCH_BUDGET_BYTES,
    preferRenditions: input.preferRenditions ?? DEFAULT_PREFER_RENDITIONS,
    cloudBytes: buildCloudBytesDeps(input),
    // The OTHER consumer of the GATED `remoteVlm` above, alongside `buildRemoteFor` below:
    // `findCandidates` (media-discovery.ts) reads THIS field to re-offer a locally-understood,
    // actively-granted artifact (spec § 19.1). Omitted (rather than `null`), matching the field's
    // own `string | undefined` shape on `MediaPassDeps` -- an install with no USABLE remote vendor
    // (unconfigured, OR configured but not enabled under `[llm.remote.<vendor>]`) must run the
    // exact query it ran before PR 4, with no parameter bound for a clause that isn't there, not a
    // `null` threaded through and compared away.
    ...(remoteVlm === null ? {} : { remoteVendor: remoteVlm }),
    gate: {
      enabled: input.enabled,
      capabilityDisabled: input.capabilityDisabled,
      // `candidate` is still not consulted HERE: the LOCAL resolution stays purely modality-keyed
      // — both registered understanders are local, so there is nothing per-artifact to decide on
      // this arm. Per-artifact eligibility now lives on `remoteFor` below instead, which is the
      // seam that actually varies by candidate (this image has a grant, that one does not).
      understanderFor: (
        modality: MediaModality,
        _candidate: MediaCandidate,
      ): Understander | undefined => (modality === "av" ? avUnderstander : imageUnderstander),
      remoteFor: buildRemoteFor(input, remoteVlm),
      gpu: {
        acquire: (id: string) => arbiter.acquire(id),
        // Load-bearing: a multi-minute transcription without a heartbeat is evicted by the
        // arbiter's idle timer, and `forceRelease()` wipes the waiter queue with it.
        touch: () => arbiter.touch(),
      },
    },
  };
}

/**
 * The `[[filesystem.roots]]` paths opted into media indexing (`media_index = true`, Task 4b) —
 * the ONLY roots `resolveLocalMediaPath` (media-bytes.ts) may read a candidate from. Deliberately
 * narrower than the full configured root set: a candidate item can only exist for a root that had
 * `media_index = true` at sync time (`filesystem-v2-sync.ts`), so widening the read boundary to
 * every configured root would admit paths the user never opted into for media understanding.
 *
 * Read live per call, matching `ownershipRoots` (`ownership/ownership-target.ts`) and `whyRoots`
 * (`agents-rpc.ts`) — a `[[filesystem.roots]]` edit applies on the next call, no gateway restart.
 * With no `configDir` (the test/embedded shape), the root set is empty.
 */
export function resolveMediaRoots(configDir: string | undefined): string[] {
  if (configDir === undefined) {
    return [];
  }
  return loadNimbusFilesystemRootsFromConfigDir(configDir)
    .filter((r) => r.mediaIndex)
    .map((r) => r.path);
}
