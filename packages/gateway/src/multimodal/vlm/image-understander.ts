/**
 * `VlmProvider` -> `LocalUnderstander`, so a still image flows through the SAME
 * `understandArtifact` chokepoint as audio and video (spec § 3.2). The gate gains an arm, not a
 * bypass.
 *
 * Nothing is written to disk on this path: a local artifact is read into memory and a cloud
 * artifact's bytes are taken directly (`MediaSource`, PR 3) — either way the provider is handed
 * bytes, never a path (spec § 5.4). The one scratch file the subsystem writes remains the audio
 * transcode's WAV.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import type { LocalUnderstander } from "../media-gate.ts";
import type { MediaSource, UnderstandDetail } from "../media-types.ts";
import { UnsupportedImageFormatError } from "../media-types.ts";
import { IMAGE_CAPTION_PROMPT } from "./caption-prompts.ts";
import { resolveWireMime } from "./image-mime.ts";
import type { VlmProvider } from "./vlm-types.ts";

export interface ImageUnderstanderDeps {
  readonly vlm: VlmProvider;
  /** Injected for tests; production uses `node:fs/promises`. */
  readonly readFile?: (path: string) => Promise<Uint8Array>;
}

export function createImageUnderstander(deps: ImageUnderstanderDeps): LocalUnderstander {
  const read = deps.readFile ?? (async (p: string) => new Uint8Array(await fsReadFile(p)));
  return {
    // MIRRORED from the provider, never hardcoded. The gate reads this to decide whether a
    // per-artifact remote grant is required (spec § 3.4 step 3, invariant I34); a hardcoded `true`
    // here would route a remote VLM straight past that check.
    get isLocal(): boolean {
      return deps.vlm.isLocal;
    },
    model: deps.vlm.model,
    isAvailable: () => deps.vlm.isAvailable(),
    async understand(source: MediaSource): Promise<UnderstandDetail> {
      // Cloud bytes never touch disk (spec § 5.4, PR 3): take them directly. A local artifact
      // still resolves to a path and is read here, unchanged from PR 1/2.
      const bytes = source.kind === "bytes" ? source.bytes : await read(source.path);
      const label = source.kind === "bytes" ? "<in-memory bytes>" : source.path;
      if (bytes.byteLength === 0) {
        // Base64 of nothing is `""`, so this would POST `images: [""]` and buy a 400 that reaches
        // the user as the vaguer `transcribe_failed`. Refuse before the call, not after it.
        throw new Error(`image source is empty: ${label}`);
      }
      const wire = resolveWireMime(bytes, source.kind === "bytes" ? source.mime : null);
      if (wire === null) {
        throw new UnsupportedImageFormatError(
          "image bytes are not JPEG, PNG, WebP or GIF — refusing rather than sending an unknown type",
        );
      }
      const { text } = await deps.vlm.describe({
        bytes,
        prompt: IMAGE_CAPTION_PROMPT,
        mimeType: wire,
        egressMethod: "multimodal.vlm.image",
      });
      const caption = text.trim();
      if (caption === "") {
        // REJECT rather than return "". `understandArtifact` turns this into the
        // `transcribe_failed` skip reason, which the pass summary discloses and a re-run retries.
        // Writing an empty-bodied row instead would claim an understanding that did not happen.
        throw new Error(`vlm returned an empty caption for ${label}`);
      }
      // No frame counts: an image was never sampled. Omitting them is what lets a reader tell that
      // apart from a video whose every frame failed, which reports `framesCaptioned: 0`.
      return { text: caption };
    },
  };
}
