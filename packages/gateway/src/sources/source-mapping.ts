/**
 * The effective source mapping: which indexed `service:type` the decisions pass mines, and as what
 * kind. Built from the built-in table plus the `[sources]` section of the layered config
 * (pack < base < profile), read live per call. Packs only ADD types; the owner's base and profile
 * files may add, re-kind or `exclude` any type. `nimbus:*` never resolves from any layer (I28).
 */

import { type ConfigSnapshot, getLayeredConfig } from "../config/layered-config.ts";
import {
  type EffectiveEntry,
  type LayerRef,
  layerLabel as label,
  layerValues,
} from "../config/layered-merge.ts";
import { parseStrictStringList } from "../config/strict-string-list.ts";
import {
  builtinSourceEntries,
  PASS_KINDS,
  SOURCE_KINDS,
  type SourceKind,
  type SourcePass,
} from "./source-kinds.ts";

export type SourceMapEntry = { readonly serviceType: string; readonly kind: SourceKind };

export type SourceOrigin =
  | { readonly kind: "builtin" }
  | { readonly kind: "layer"; readonly layer: LayerRef };

export interface SourceMapping {
  kindOf(serviceType: string): SourceKind | undefined;
  typesFor(pass: SourcePass): readonly string[];
  typesOfKind(kind: SourceKind): readonly string[];
  readonly entries: readonly {
    serviceType: string;
    kind: SourceKind;
    origin: SourceOrigin;
  }[];
  readonly excluded: readonly { serviceType: string; layer: LayerRef }[];
  readonly notes: readonly string[];
}

/** Email and calendar: a pack may not route a personal inbox into a team artifact. The owner may. */
export const PERSONAL_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "gmail:email",
  "outlook:email",
  "imap:email",
  "fastmail:email",
  "protonmail:email",
  "apple:email",
  "apple:event",
]);

const TYPE_RE = /^([a-z0-9_]+):([a-z0-9_]+)$/;
const KIND_SET: ReadonlySet<string> = new Set(SOURCE_KINDS);

function parseServiceType(raw: string): string | undefined {
  const m = TYPE_RE.exec(raw);
  if (m === null || m[1] === "nimbus") return undefined;
  return raw;
}

export function parseSourceMapEntry(raw: string): SourceMapEntry | undefined {
  const eq = raw.indexOf("=");
  if (eq < 0 || raw.includes("=", eq + 1)) return undefined;
  const type = raw.slice(0, eq);
  const kind = raw.slice(eq + 1);
  const serviceType = parseServiceType(type);
  if (serviceType === undefined || !KIND_SET.has(kind)) return undefined;
  return { serviceType, kind: kind as SourceKind };
}

export function parseSourceMapList(valRaw: string): readonly string[] | undefined {
  return parseStrictStringList(valRaw, (e) => parseSourceMapEntry(e) !== undefined);
}

export function parseSourceTypeList(valRaw: string): readonly string[] | undefined {
  return parseStrictStringList(valRaw, (e) => parseServiceType(e) !== undefined);
}

const isDefined = <T>(x: T | undefined): x is T => x !== undefined;

/** The one conversion from an already-validated `map` list to entries. */
export function sourceMapFromList(
  entries: readonly string[] | undefined,
): ReadonlyMap<string, SourceKind> {
  const parsed = (entries === undefined ? [] : entries).map(parseSourceMapEntry).filter(isDefined);
  return new Map(parsed.map((e) => [e.serviceType, e.kind]));
}

type Slot = { kind: SourceKind; origin: SourceOrigin };

function build(
  slots: ReadonlyMap<string, Slot>,
  excluded: readonly { serviceType: string; layer: LayerRef }[],
  notes: readonly string[],
): SourceMapping {
  // Built-in table order first, then added types in layer order, however a layer re-kinded or
  // re-added a built-in.
  const builtinKeys = builtinSourceEntries().map(([key]) => key);
  const builtinSet = new Set(builtinKeys);
  const order = [
    ...builtinKeys.filter((k) => slots.has(k)),
    ...[...slots.keys()].filter((k) => !builtinSet.has(k)),
  ];
  const entries = Object.freeze(
    order.map((serviceType) => Object.freeze({ serviceType, ...(slots.get(serviceType) as Slot) })),
  );
  const typesWhere = (keep: (k: SourceKind) => boolean): readonly string[] =>
    Object.freeze(entries.filter((e) => keep(e.kind)).map((e) => e.serviceType));
  const byPass: Readonly<Record<SourcePass, readonly string[]>> = {
    decisions: typesWhere((k) => PASS_KINDS.decisions.has(k)),
    glossary: typesWhere((k) => PASS_KINDS.glossary.has(k)),
  };
  const byKind = Object.fromEntries(
    SOURCE_KINDS.map((kind) => [kind, typesWhere((k) => k === kind)]),
  ) as Readonly<Record<SourceKind, readonly string[]>>;
  return {
    kindOf: (serviceType) => slots.get(serviceType)?.kind,
    typesFor: (pass) => byPass[pass],
    typesOfKind: (kind) => byKind[kind],
    entries,
    excluded: Object.freeze([...excluded]),
    notes: Object.freeze([...notes]),
  };
}

function builtinSlots(): Map<string, Slot> {
  return new Map(
    builtinSourceEntries().map(([key, kind]): [string, Slot] => [
      key,
      { kind, origin: { kind: "builtin" } },
    ]),
  );
}

export const BUILTIN_SOURCE_MAPPING: SourceMapping = build(builtinSlots(), [], []);

const layerOrigin = (l: LayerRef): string => (l.kind === "pack" ? `pack ${l.id}` : l.kind);

type Walk = {
  slots: Map<string, Slot>;
  excluded: { serviceType: string; layer: LayerRef }[];
  notes: string[];
};

function packEntry(walk: Walk, layer: LayerRef, e: SourceMapEntry): void {
  const cur = walk.slots.get(e.serviceType);
  if (PERSONAL_SOURCE_TYPES.has(e.serviceType)) {
    walk.notes.push(
      `${e.serviceType} in ${label(layer)} [sources] map is a personal type; ignored`,
    );
  } else if (cur === undefined) {
    walk.slots.set(e.serviceType, { kind: e.kind, origin: { kind: "layer", layer } });
  } else if (cur.origin.kind === "builtin" || cur.kind !== e.kind) {
    walk.notes.push(
      `${e.serviceType} in ${label(layer)} [sources] map is already mapped; a pack only adds new types`,
    );
  }
}

function applyPack(walk: Walk, layer: LayerRef, valRaw: string): void {
  const list = parseSourceMapList(valRaw);
  if (list === undefined) {
    walk.notes.push(`[sources] map in ${label(layer)} is not a valid list of entries: ${valRaw}`);
    return;
  }
  for (const e of list.map(parseSourceMapEntry).filter(isDefined)) packEntry(walk, layer, e);
}

/** A pack-added type an owner layer is about to replace or remove: say so, it is otherwise silent. */
function noteShadowedPack(walk: Walk, serviceType: string, outcome: string): void {
  const cur = walk.slots.get(serviceType);
  if (cur?.origin.kind === "layer" && cur.origin.layer.kind === "pack") {
    walk.notes.push(`pack ${cur.origin.layer.id} maps ${serviceType} as ${cur.kind}; ${outcome}`);
  }
}

function applyOwnerMap(walk: Walk, layer: LayerRef, mapRaw: string): void {
  const list = parseSourceMapList(mapRaw);
  if (list === undefined) {
    walk.notes.push(`[sources] map in ${label(layer)} is not a valid list of entries: ${mapRaw}`);
    return;
  }
  for (const [serviceType, kind] of sourceMapFromList(list)) {
    noteShadowedPack(walk, serviceType, `overridden by ${layerOrigin(layer)} (${kind})`);
    walk.slots.set(serviceType, { kind, origin: { kind: "layer", layer } });
    // A later layer re-mapping a type an earlier layer excluded brings it back.
    walk.excluded = walk.excluded.filter((x) => x.serviceType !== serviceType);
  }
}

function applyOwnerExclude(walk: Walk, layer: LayerRef, excludeRaw: string): void {
  const list = parseSourceTypeList(excludeRaw);
  if (list === undefined) {
    walk.notes.push(
      `[sources] exclude in ${label(layer)} is not a valid list of service:type: ${excludeRaw}`,
    );
    return;
  }
  for (const serviceType of list) {
    noteShadowedPack(walk, serviceType, `excluded by ${layerOrigin(layer)}`);
    walk.slots.delete(serviceType);
    walk.excluded.push({ serviceType, layer });
  }
}

function valuesOf(entries: readonly EffectiveEntry[], key: string, kind: LayerRef["kind"]) {
  return layerValues(entries, key).filter((v) => v.layer.kind === kind);
}

export function resolveSourceMapping(snapshot: Pick<ConfigSnapshot, "doc">): SourceMapping {
  const section = snapshot.doc.sections.find((s) => s.header === "sources" && !s.isArray);
  if (section === undefined) return BUILTIN_SOURCE_MAPPING;
  const walk: Walk = { slots: builtinSlots(), excluded: [], notes: [] };
  // A misspelt key (`excludes`, `maps`) would otherwise do nothing, silently.
  const knownKeys = new Set(["map", "exclude"]);
  for (const key of new Set(section.entries.map((e) => e.key))) {
    if (knownKeys.has(key)) continue;
    for (const { layer } of layerValues(section.entries, key)) {
      walk.notes.push(`[sources] ${key} in ${label(layer)} is not a known key; ignored`);
    }
  }
  for (const { layer, valRaw } of valuesOf(section.entries, "map", "pack")) {
    applyPack(walk, layer, valRaw);
  }
  for (const { layer } of valuesOf(section.entries, "exclude", "pack")) {
    walk.notes.push(`[sources] exclude in ${label(layer)} is ignored: only the owner excludes`);
  }
  for (const kind of ["base", "profile"] as const) {
    for (const { layer, valRaw } of valuesOf(section.entries, "map", kind)) {
      applyOwnerMap(walk, layer, valRaw);
    }
    for (const { layer, valRaw } of valuesOf(section.entries, "exclude", kind)) {
      applyOwnerExclude(walk, layer, valRaw);
    }
  }
  // Defence in depth (I28): the parsers already refuse `nimbus:*`; drop any that got through.
  const leaked = [...walk.slots.keys()].filter((k) => k.startsWith("nimbus:"));
  for (const k of leaked) walk.slots.delete(k);
  walk.notes.push(...leaked.map((k) => `${k} is a gateway-written type and is never a source`));
  return build(walk.slots, walk.excluded, walk.notes);
}

export function sourceMappingFor(configDir: string | undefined): SourceMapping {
  if (configDir === undefined) return BUILTIN_SOURCE_MAPPING;
  return resolveSourceMapping(getLayeredConfig(configDir).snapshot());
}

/** `config explain sources`: each effective entry with its origin, each exclusion, then the notes. */
export function describeSourceMapping(mapping: SourceMapping): readonly string[] {
  const lines = mapping.entries.map(
    (e) =>
      `source ${e.serviceType} is mined as ${e.kind} (${e.origin.kind === "builtin" ? "built-in" : layerOrigin(e.origin.layer)})`,
  );
  const seen = new Set<string>();
  for (const x of mapping.excluded) {
    const line = `source ${x.serviceType} is excluded by ${layerOrigin(x.layer)}`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return [...lines, ...mapping.notes];
}

export function sourceFilterSql(
  types: readonly string[],
  alias: string,
): { sql: string; params: string[] } {
  if (types.length === 0) return { sql: "0", params: [] };
  const marks = types.map(() => "?").join(", ");
  return { sql: `(${alias}.service || ':' || ${alias}.type) IN (${marks})`, params: [...types] };
}
