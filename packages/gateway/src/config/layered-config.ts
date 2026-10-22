import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResolvedProfile } from "./active-profile.ts";
import { profileFilePath, readProfileMarker, resolveActiveProfile } from "./active-profile.ts";
import {
  type EffectiveDoc,
  type LayerDoc,
  type LayerRef,
  mergeLayerDocs,
  parseLayerDoc,
  renderEffectiveDoc,
} from "./layered-merge.ts";

export type ConfigSnapshot = {
  readonly version: number;
  readonly layers: readonly { readonly layer: LayerRef; readonly exists: boolean }[];
  readonly doc: EffectiveDoc;
  /** Rendered effective config; null when no user layer file (base/profile) exists. */
  readonly text: string | null;
};

export interface PackLayerSource {
  list(profile: string): readonly { readonly id: string; readonly path: string }[];
}

export const EMPTY_PACK_LAYERS: PackLayerSource = { list: () => [] };

function readOrNull(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

type Cached = { readonly snapshot: ConfigSnapshot; readonly contents: readonly (string | null)[] };

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
    const contents = refs.map((r) => readOrNull(r.path));
    const prev = this.cached;
    if (
      prev !== null &&
      prev.contents.length === contents.length &&
      prev.snapshot.layers.every((l, i) => l.layer.path === refs[i]?.path) &&
      prev.contents.every((c, i) => c === contents[i])
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
      layers: refs.map((layer, i) => ({ layer, exists: contents[i] !== null })),
      doc,
      text: hasUser ? renderEffectiveDoc(doc) : null,
    };
    this.cached = { snapshot, contents };
    return snapshot;
  }

  /** Where a write belongs: the profile overlay (even if absent) or the base file. */
  writeTargetPath(): string {
    return (
      profileFilePath(this.configDir, this.profile.name) ?? join(this.configDir, "nimbus.toml")
    );
  }

  /** The live marker, which may differ from the pinned profile. */
  markerProfile(): string {
    return readProfileMarker(this.configDir) ?? "default";
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

/** The effective (layered) config text for `configDir`; null when no user layer file exists. */
export function layeredConfigText(configDir: string): string | null {
  return getLayeredConfig(configDir).snapshot().text;
}
