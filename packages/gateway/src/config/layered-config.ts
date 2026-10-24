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
  /** Rendered effective config; null only when no layer exists at all, pack layers included. */
  readonly text: string | null;
  /** Whether a user layer file (base or profile) was read. A pack-only config has none. */
  readonly hasUserLayer: boolean;
  /** Ids of the pack layers merged into this snapshot, low to high. */
  readonly activePacks: readonly string[];
  /** Packs the source refused to hand over, with why. */
  readonly skippedPacks: readonly SkippedPack[];
  /** Set when the source could not list the profile's packs at all. */
  readonly packListError?: string;
};

/** One pack layer's already-validated text, as the pack source hands it over. */
export type PackLayerText = { readonly id: string; readonly path: string; readonly text: string };

/** A pack the source skipped (whole-layer), and why. */
export type SkippedPack = { readonly packId: string; readonly reason: string };

export type PackLayersRead = {
  readonly layers: readonly PackLayerText[];
  readonly skipped: readonly SkippedPack[];
  readonly listError?: string;
};

export interface PackLayerSource {
  /**
   * The profile's pack layers. Must never throw: every failure is a `skipped` entry or
   * `listError`. A source that throws anyway is recorded as a list error, with no packs applied.
   */
  read(profile: string): PackLayersRead;
}

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const SEPARATOR_CLASS = String.raw`[\\/]`;
const PATH_TAIL = String.raw`(?:[\\/][^\s'"\x60,;]*)?`;

/**
 * `message` with every path under `root` replaced by its basename, so a reason shown in
 * `diag.snapshot` never carries an absolute path. Either separator matches, case-insensitively
 * on Windows. Pass `root` already `resolve`d, so it has the form `fs` errors use.
 */
export function basenameSafeMessage(message: string, root: string): string {
  const parts = root.split(/[\\/]/).filter((p, i) => p !== "" || i === 0);
  const pattern = parts
    .map((p) => p.replace(REGEXP_SPECIAL, String.raw`\$&`))
    .join(SEPARATOR_CLASS);
  const re = new RegExp(pattern + PATH_TAIL, process.platform === "win32" ? "gi" : "g");
  return message.replace(re, (m) => m.split(/[\\/]/).findLast((p) => p !== "") ?? m);
}

export const EMPTY_PACK_LAYERS: PackLayerSource = { read: () => ({ layers: [], skipped: [] }) };

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

type Cached = {
  readonly snapshot: ConfigSnapshot;
  readonly reads: readonly LayerRead[];
  readonly packs: PackLayersRead;
};

/** Whether two pack reads would produce the same snapshot. */
function samePackRead(a: PackLayersRead, b: PackLayersRead): boolean {
  return (
    a.layers.length === b.layers.length &&
    a.layers.every((l, i) => {
      const o = b.layers[i];
      return l.id === o?.id && l.path === o.path && l.text === o.text;
    }) &&
    JSON.stringify(a.skipped) === JSON.stringify(b.skipped) &&
    a.listError === b.listError
  );
}

/**
 * Layered reader: pack layers, then base, then the pinned profile overlay (low to high).
 * Pack text comes from the `PackLayerSource` (already validated there; a refused pack arrives
 * as a skip, never as text), read once per snapshot; base and profile are read from disk here.
 * Freshness is content-based: every call re-reads, and re-merges only when something differs
 * from the cached read (a file's text, a file appearing/disappearing, the pack set, a pack's
 * text, the skipped set or the list error).
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

  /** The user layers: base, then the profile overlay when the profile has its own file. */
  private userLayerRefs(): LayerRef[] {
    const refs: LayerRef[] = [
      { kind: "base", id: "base", path: join(this.configDir, "nimbus.toml") },
    ];
    const profilePath = profileFilePath(this.configDir, this.profile.name);
    if (profilePath !== null) {
      refs.push({ kind: "profile", id: this.profile.name, path: profilePath });
    }
    return refs;
  }

  snapshot(): ConfigSnapshot {
    const packs = this.readPacks();
    const userRefs = this.userLayerRefs();
    const reads = userRefs.map((r) => readLayer(r.path));
    const prev = this.cached;
    if (
      prev !== null &&
      samePackRead(prev.packs, packs) &&
      prev.reads.length === reads.length &&
      prev.snapshot.layers
        .slice(packs.layers.length)
        .every((l, i) => l.layer.path === userRefs[i]?.path) &&
      prev.reads.every((c, i) => c.text === reads[i]?.text && c.readError === reads[i]?.readError)
    ) {
      return prev.snapshot;
    }
    const packRefs: LayerRef[] = packs.layers.map((p) => ({
      kind: "pack" as const,
      id: p.id,
      path: p.path,
    }));
    const refs = [...packRefs, ...userRefs];
    const contents: (string | null)[] = [
      ...packs.layers.map((p) => p.text),
      ...reads.map((r) => r.text),
    ];
    const docs: LayerDoc[] = [];
    refs.forEach((ref, i) => {
      const text = contents[i];
      if (text !== null && text !== undefined) docs.push(parseLayerDoc(ref, text));
    });
    const doc = mergeLayerDocs(docs);
    this.version += 1;
    this.fallbacks = new Map();
    const snapshot: ConfigSnapshot = {
      version: this.version,
      layers: refs.map((layer, i) => {
        const readError = reads[i - packRefs.length]?.readError;
        return {
          layer,
          exists: contents[i] !== null,
          ...(readError !== undefined ? { readError } : {}),
        };
      }),
      doc,
      text: docs.length > 0 ? renderEffectiveDoc(doc) : null,
      hasUserLayer: reads.some((r) => r.text !== null),
      activePacks: packs.layers.map((p) => p.id),
      skippedPacks: packs.skipped,
      ...(packs.listError !== undefined ? { packListError: packs.listError } : {}),
    };
    this.cached = { snapshot, reads, packs };
    return snapshot;
  }

  /**
   * The source's read for the pinned profile, with its arrays copied so a source that mutates
   * them cannot alter the cached read; a throwing source becomes a list error with no packs.
   */
  private readPacks(): PackLayersRead {
    try {
      const r = this.packs.read(this.profile.name);
      return { ...r, layers: [...r.layers], skipped: [...r.skipped] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        layers: [],
        skipped: [],
        listError: `pack source failed: ${basenameSafeMessage(message, resolve(this.configDir))}`,
      };
    }
  }

  /** The pack source this reader was built with; `initLayeredConfig` compares it by identity. */
  packSource(): PackLayerSource {
    return this.packs;
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
    // Returning the existing reader would silently drop `opts.packs` (for example after
    // `getLayeredConfig` created one), and every snapshot would then miss the pack layers.
    if (opts.packs !== undefined && existing.packSource() !== opts.packs) {
      throw new Error(
        `Layered config for ${key} already initialised with a different pack source; pass the pack source to the first initLayeredConfig call`,
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

/** The registered reader for `configDir`, or undefined; never creates one. */
export function peekLayeredConfig(configDir: string): LayeredConfig | undefined {
  return registry.get(resolve(configDir));
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

/**
 * The effective (layered) config text for `configDir`; null only when no layer exists at all.
 * A pack-only config renders, so a loader whose "no file" result differs from its result on
 * text without that section must also check `layeredHasUserLayer`.
 */
export function layeredConfigText(configDir: string): string | null {
  return getLayeredConfig(configDir).snapshot().text;
}

/** Whether a user layer file (base or profile) was read for `configDir`. */
export function layeredHasUserLayer(configDir: string): boolean {
  return getLayeredConfig(configDir).snapshot().hasUserLayer;
}
