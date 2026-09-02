/**
 * Constructs the production dependencies for the understanding pass.
 *
 * Separate from `media-pass.ts` so the pass stays a pure orchestrator over injected seams and can
 * be tested without a whisper binary, an arbiter or a config. This is the one place that knows
 * what the real implementations are.
 *
 * `sttFor("image")` returns undefined DELIBERATELY: PR 1 ships no VLM, so an image candidate is
 * skipped as `unresolvable_modality` rather than mis-handed to the STT path. PR 2 adds that arm.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import { stripComment } from "../config/toml-primitives.ts";
import { GpuArbiter } from "../llm/gpu-arbiter.ts";
import { WhisperSttProvider } from "../voice/stt.ts";
import type { LocalUnderstander } from "./media-gate.ts";
import type { MediaPassDeps } from "./media-pass.ts";
import type { MediaModality } from "./media-types.ts";
import { resolveFfmpegBin } from "./stt/ffmpeg-bin.ts";
import { createLongFormStt } from "./stt/long-form-stt.ts";

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
}

/** 250 MB (spec § 5.3 `max_media_bytes`). */
const DEFAULT_MAX_MEDIA_BYTES = 250 * 1024 * 1024;

export type BuiltMediaPassDeps = Omit<
  MediaPassDeps,
  "limit" | "service" | "modality" | "sinceMs" | "afterItemId"
>;

export function buildMediaPassDeps(input: BuildMediaPassDepsInput): BuiltMediaPassDeps {
  const whisper = new WhisperSttProvider(
    input.whisperBin === undefined ? {} : { whisperBin: input.whisperBin },
  );
  const stt = createLongFormStt({
    transcribe: (wavPath: string) => whisper.transcribe(wavPath),
    isAvailable: () => whisper.isAvailable(),
    ffmpegBin: resolveFfmpegBin(input.ffmpegBin),
    scratchDir: input.scratchDir,
    model: "whisper-cli",
  });

  const arbiter = input.gpu ?? new GpuArbiter();

  return {
    db: input.db,
    roots: input.roots,
    maxBytes: input.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES,
    nowMs: () => Date.now(),
    passId: "default",
    scratchDir: input.scratchDir,
    gate: {
      enabled: input.enabled,
      capabilityDisabled: input.capabilityDisabled,
      sttFor: (modality: MediaModality): LocalUnderstander | undefined =>
        modality === "av" ? stt : undefined,
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

/**
 * `[multimodal] enabled` — DEFAULT OFF, matching every other S2 capability toggle
 * (`[code_execution] enabled`, `[computer_use] enabled`). Absent section, absent key, absent
 * `nimbus.toml`, or no `configDir` at all (the test/embedded shape) all read as `false` — a
 * missing or malformed config must never read as "on".
 *
 * Hand-rolled rather than routed through `nimbus-toml.ts`, mirroring
 * `connectors/openapi-indexer-config.ts`'s standalone section reader: one boolean key does not
 * warrant a shared parser's full section-table machinery. Reuses `stripComment` from the
 * dependency-free `toml-primitives.ts` so a value like `enabled = true # turn on locally` is
 * read correctly.
 */
export function resolveMultimodalEnabled(configDir: string | undefined): boolean {
  if (configDir === undefined) {
    return false;
  }
  const tomlPath = join(configDir, "nimbus.toml");
  if (!existsSync(tomlPath)) {
    return false;
  }
  try {
    return parseMultimodalEnabled(readFileSync(tomlPath, "utf8"));
  } catch {
    return false;
  }
}

function parseMultimodalEnabled(raw: string): boolean {
  let inSection = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("[")) {
      inSection = line === "[multimodal]";
      continue;
    }
    if (!inSection) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    if (line.slice(0, eq).trim() !== "enabled") {
      continue;
    }
    const val = line
      .slice(eq + 1)
      .trim()
      .toLowerCase();
    if (val === "true") return true;
    if (val === "false") return false;
  }
  return false;
}
