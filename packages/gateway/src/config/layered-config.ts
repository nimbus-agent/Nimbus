import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResolvedProfile } from "./active-profile.ts";
import { profileFilePath, resolveActiveProfile, tryReadProfileMarker } from "./active-profile.ts";
import {
  type EffectiveDoc,
  type LayerDoc,
  type LayerRef,
  mergeLayerDocs,
  parseLayerDoc,
  renderEffectiveDoc,
} from "./layered-merge.ts";

/** One layer of a snapshot. `readError` is a non-ENOENT read failure; the layer is then absent. */
export type SnapshotLayer = {
  readonly layer: LayerRef;
  readonly exists: boolean;
  readonly readError?: string;
};

export type ConfigSnapshot = {
  readonly version: number;
  readonly layers: readonly SnapshotLayer[];
  readonly doc: EffectiveDoc;
  /** Rendered effective config; null when no user layer file (base/profile) exists. */
  readonly text: string | null;
};

export interface PackLayerSource {
  list(profile: string): readonly { readonly id: string; readonly path: string }[];
}

export const EMPTY_PACK_LAYERS: PackLayerSource = { list: () => [] };

type LayerRead = { readonly text: string | null; readonly readError?: string };

/** A layer file's text; null when absent. Any other read failure is kept as `readError`. */
function readLayer(path: string): LayerRead {
  try {
    return { text: readFileSync(path, "utf8") };
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: null };
    }
    return { text: null, readError: err instanceof Error ? err.message : String(err) };
  }
}

type Cached = { readonly snapshot: ConfigSnapshot; readonly reads: readonly LayerRead[] };

/**
 * Layered reader: pack layers, then base, then the pinned profile overlay (low to high).
 * Freshness is content-based: every call re-reads each layer file and re-merges only
 * when some file's text differs from the cached text (or a file appeared/disappeared).
 */
export class LayeredConfig {
  readonly configDir: string;
  readonly profile: ResolvedProfile;
  private readonly packs: PackLayerSource;
  private cached: Cached | null = null;
  private version = 0;
  private fallbacks = new Map<string, string>();

  constructor(opts: { configDir: string; profile: ResolvedProfile; packs?: PackLayerSource }) {
    this.configDir = opts.configDir;
    this.profile = opts.profile;
    this.packs = opts.packs ?? EMPTY_PACK_LAYERS;
  }

  private layerRefs(): LayerRef[] {
    const refs: LayerRef[] = this.packs
      .list(this.profile.name)
      .map((p) => ({ kind: "pack" as const, id: p.id, path: p.path }));
    refs.push({ kind: "base", id: "base", path: join(this.configDir, "nimbus.toml") });
    const profilePath = profileFilePath(this.configDir, this.profile.name);
    if (profilePath !== null) {
      refs.push({ kind: "profile", id: this.profile.name, path: profilePath });
    }
    return refs;
  }

  snapshot(): ConfigSnapshot {
    const refs = this.layerRefs();
    const reads = refs.map((r) => readLayer(r.path));
    const contents = reads.map((r) => r.text);
    const prev = this.cached;
    if (
      prev !== null &&
      prev.reads.length === reads.length &&
      prev.snapshot.layers.every((l, i) => l.layer.path === refs[i]?.path) &&
      prev.reads.every((c, i) => c.text === reads[i]?.text && c.readError === reads[i]?.readError)
    ) {
      return prev.snapshot;
    }
    const docs: LayerDoc[] = [];
    refs.forEach((ref, i) => {
      const text = contents[i];
      if (text !== null && text !== undefined) docs.push(parseLayerDoc(ref, text));
    });
    const doc = mergeLayerDocs(docs);
    const hasUser = refs.some(
      (r, i) => (r.kind === "base" || r.kind === "profile") && contents[i] !== null,
    );
    this.version += 1;
    this.fallbacks = new Map();
    const snapshot: ConfigSnapshot = {
      version: this.version,
      layers: refs.map((layer, i) => {
        const readError = reads[i]?.readError;
        return {
          layer,
          exists: contents[i] !== null,
          ...(readError !== undefined ? { readError } : {}),
        };
      }),
      doc,
      text: hasUser ? renderEffectiveDoc(doc) : null,
    };
    this.cached = { snapshot, reads };
    return snapshot;
  }

  /** Where a write belongs: the profile overlay (even if absent) or the base file. */
  writeTargetPath(): string {
    return (
      profileFilePath(this.configDir, this.profile.name) ?? join(this.configDir, "nimbus.toml")
    );
  }

  /** The live marker, which may differ from the pinned profile; an unreadable one reads as absent. */
  markerProfile(): string {
    return tryReadProfileMarker(this.configDir) ?? "default";
  }

  recordSectionFallback(header: string, message: string): void {
    this.snapshot();
    this.fallbacks.set(header, message);
  }

  sectionFallback(header: string): string | undefined {
    this.snapshot();
    return this.fallbacks.get(header);
  }
}

const registry = new Map<string, LayeredConfig>();

export function initLayeredConfig(
  configDir: string,
  opts: { explicitProfile?: string; packs?: PackLayerSource } = {},
): LayeredConfig {
  const key = resolve(configDir);
  const profile = resolveActiveProfile({
    configDir,
    ...(opts.explicitProfile !== undefined ? { explicit: opts.explicitProfile } : {}),
  });
  const existing = registry.get(key);
  if (existing !== undefined) {
    if (existing.profile.name !== profile.name) {
      throw new Error(
        `Layered config for ${key} already initialised with profile "${existing.profile.name}", not "${profile.name}"`,
      );
    }
    return existing;
  }
  const created = new LayeredConfig({
    configDir,
    profile,
    ...(opts.packs !== undefined ? { packs: opts.packs } : {}),
  });
  registry.set(key, created);
  return created;
}

export function getLayeredConfig(configDir: string): LayeredConfig {
  return registry.get(resolve(configDir)) ?? initLayeredConfig(configDir);
}

/** Test-only: drop one config dir's entry, leaving every other dir's reader alone. */
export function forgetLayeredConfigForTests(configDir: string): void {
  registry.delete(resolve(configDir));
}

export function resetLayeredConfigsForTests(): void {
  registry.clear();
}

/** Called with the error message when a loader swallows, logs or converts a section error. */
export type SectionFallbackSink = (message: string) => void;

/** The message of a caught value, for a section fallback record. */
export function fallbackMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A sink recording into the layered reader for `configDir` under `sectionId` (unbracketed). */
export function sectionFallbackSink(configDir: string, sectionId: string): SectionFallbackSink {
  return (message) => getLayeredConfig(configDir).recordSectionFallback(sectionId, message);
}

/**
 * The first layer that exists but could not be read, as "could not read <path>: <message>";
 * undefined when every layer read cleanly or is absent. The snapshot treats such a layer as
 * absent, so a loader that must not run on a partial config throws this, and one that falls
 * back records it.
 */
export function layerReadError(configDir: string): string | undefined {
  for (const l of getLayeredConfig(configDir).snapshot().layers) {
    if (l.readError !== undefined) return `could not read ${l.layer.path}: ${l.readError}`;
  }
  return undefined;
}

/** Throws `layerReadError` as an Error, for the loaders whose single-file reader let a read error escape. */
export function assertLayersReadable(configDir: string): void {
  const err = layerReadError(configDir);
  if (err !== undefined) throw new Error(err);
}

/** The effective (layered) config text for `configDir`; null when no user layer file exists. */
export function layeredConfigText(configDir: string): string | null {
  return getLayeredConfig(configDir).snapshot().text;
}
