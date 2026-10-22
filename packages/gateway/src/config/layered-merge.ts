// Line-level layer documents and the low -> high merge behind the layered config
// reader. Pure: no I/O. Each layer file is parsed into sections of key/value lines
// (raw text kept verbatim), the layers are merged with provenance, and the result is
// rendered back to canonical TOML text that the existing per-section parsers read
// unchanged.

import {
  hasUnterminatedString,
  isTableHeader,
  parseString,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

export type LayerKind = "pack" | "team" | "base" | "profile";

export type LayerRef = {
  readonly kind: LayerKind;
  /** The pack id, `"team"`, `"base"`, or the profile name. */
  readonly id: string;
  readonly path: string;
};

export type DocLine =
  | { readonly kind: "entry"; readonly key: string; readonly valRaw: string; readonly raw: string }
  | { readonly kind: "passthrough"; readonly raw: string };

export type DocSection = {
  /** Trimmed header text without brackets, or `null` for keys above the first header. */
  readonly header: string | null;
  readonly isArray: boolean;
  /** The raw header line of a broken-header section. */
  readonly malformed?: string;
  readonly lines: readonly DocLine[];
};

export type LayerDoc = { readonly layer: LayerRef; readonly sections: readonly DocSection[] };

export type EffectiveEntry = {
  readonly key: string;
  readonly valRaw: string;
  readonly raw: string;
  readonly layer: LayerRef;
  readonly shadowed: readonly { readonly layer: LayerRef; readonly valRaw: string }[];
};

export type EffectiveSection = {
  readonly header: string | null;
  readonly isArray: boolean;
  readonly malformed?: string;
  readonly blockLayer?: LayerRef;
  readonly entries: readonly EffectiveEntry[];
  readonly passthrough: readonly { readonly layer: LayerRef; readonly raw: string }[];
};

export type EffectiveDoc = { readonly sections: readonly EffectiveSection[] };

type ParsedHeader = { header: string; isArray: boolean };

/** `undefined` when a line that starts with `[` is not a well-formed `[x]` / `[[x]]` header. */
function parseHeaderLine(trimmed: string): ParsedHeader | undefined {
  if (hasUnterminatedString(trimmed)) return undefined;
  const text = stripComment(trimmed).trim();
  if (!isTableHeader(text)) return undefined;
  const isArray = text.startsWith("[[") && text.endsWith("]]") && text.length >= 4;
  const inner = (isArray ? text.slice(2, -2) : text.slice(1, -1)).trim();
  if (inner.length === 0 || inner.startsWith("[") || inner.endsWith("]")) return undefined;
  return { header: inner, isArray };
}

function classifyLine(line: string): DocLine {
  if (hasUnterminatedString(line)) return { kind: "passthrough", raw: line };
  const kv = splitKeyValue(stripComment(line).trim());
  if (kv === undefined) return { kind: "passthrough", raw: line };
  return { kind: "entry", key: kv.key, valRaw: kv.valRaw, raw: line };
}

export function parseLayerDoc(layer: LayerRef, text: string): LayerDoc {
  const sections: DocSection[] = [];
  let current: { header: string | null; isArray: boolean; malformed?: string; lines: DocLine[] } = {
    header: null,
    isArray: false,
    lines: [],
  };
  const flush = (): void => {
    if (current.header !== null || current.malformed !== undefined || current.lines.length > 0) {
      sections.push(current);
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      flush();
      const parsed = parseHeaderLine(trimmed);
      current =
        parsed === undefined
          ? { header: null, isArray: false, malformed: line, lines: [] }
          : { header: parsed.header, isArray: parsed.isArray, lines: [] };
      continue;
    }
    current.lines.push(classifyLine(line));
  }
  flush();
  return { layer, sections };
}

type Layered = { readonly layerIndex: number; readonly section: DocSection };

/** Builds a plain table: last-winning layer per key, with the lower layers' values as `shadowed`. */
function mergePlainSections(
  header: string | null,
  parts: readonly Layered[],
  layers: readonly LayerRef[],
): EffectiveSection {
  const keyOrder: string[] = [];
  const byKey = new Map<
    string,
    { layerIndex: number; entries: { valRaw: string; raw: string }[] }[]
  >();
  const passthrough: { layer: LayerRef; raw: string }[] = [];
  for (const { layerIndex, section } of parts) {
    for (const line of section.lines) {
      if (line.kind === "passthrough") {
        passthrough.push({ layer: layers[layerIndex] as LayerRef, raw: line.raw });
        continue;
      }
      let perLayer = byKey.get(line.key);
      if (perLayer === undefined) {
        perLayer = [];
        byKey.set(line.key, perLayer);
        keyOrder.push(line.key);
      }
      let slot = perLayer.find((p) => p.layerIndex === layerIndex);
      if (slot === undefined) {
        slot = { layerIndex, entries: [] };
        perLayer.push(slot);
      }
      slot.entries.push({ valRaw: line.valRaw, raw: line.raw });
    }
  }
  const entries: EffectiveEntry[] = [];
  for (const key of keyOrder) {
    const perLayer = [...(byKey.get(key) ?? [])].sort((a, b) => a.layerIndex - b.layerIndex);
    const winner = perLayer.at(-1);
    if (winner === undefined) continue;
    const shadowed = perLayer.slice(0, -1).map((p) => ({
      layer: layers[p.layerIndex] as LayerRef,
      valRaw: p.entries.at(-1)?.valRaw ?? "",
    }));
    for (const e of winner.entries) {
      entries.push({
        key,
        valRaw: e.valRaw,
        raw: e.raw,
        layer: layers[winner.layerIndex] as LayerRef,
        shadowed,
      });
    }
  }
  return { header, isArray: false, entries, passthrough };
}

function blockToEffective(
  section: DocSection,
  layer: LayerRef,
  extra: { malformed?: string },
): EffectiveSection {
  const entries: EffectiveEntry[] = [];
  const passthrough: { layer: LayerRef; raw: string }[] = [];
  for (const line of section.lines) {
    if (line.kind === "passthrough") passthrough.push({ layer, raw: line.raw });
    else entries.push({ key: line.key, valRaw: line.valRaw, raw: line.raw, layer, shadowed: [] });
  }
  return {
    header: section.header,
    isArray: section.isArray,
    ...(extra.malformed === undefined ? { blockLayer: layer } : { malformed: extra.malformed }),
    entries,
    passthrough,
  };
}

function fleetJobName(section: DocSection): string | undefined {
  let name: string | undefined;
  for (const line of section.lines) {
    if (line.kind === "entry" && line.key === "name") name = parseString(line.valRaw);
  }
  return name;
}

/** `[[fleet.job]]` merges by `name`: a higher layer's job replaces a lower layer's same-named one in place. */
function mergeFleetJobs(
  parts: readonly Layered[],
  layers: readonly LayerRef[],
): EffectiveSection[] {
  const out: { layerIndex: number; name: string | undefined; section: DocSection }[] = [];
  for (const { layerIndex, section } of parts) {
    const name = fleetJobName(section);
    const at =
      name === undefined ? -1 : out.findIndex((o) => o.name === name && o.layerIndex < layerIndex);
    if (at >= 0) out[at] = { layerIndex, name, section };
    else out.push({ layerIndex, name, section });
  }
  return out.map((o) => blockToEffective(o.section, layers[o.layerIndex] as LayerRef, {}));
}

/** Merges layer documents (ordered low -> high) into one effective document with provenance. */
export function mergeLayerDocs(docs: readonly LayerDoc[]): EffectiveDoc {
  const layers = docs.map((d) => d.layer);
  const slotOrder: string[] = [];
  const plain = new Map<string, Layered[]>();
  const arrays = new Map<string, Layered[]>();
  const malformed: EffectiveSection[] = [];
  const slotKey = (header: string | null, isArray: boolean): string =>
    `${isArray ? "A" : "P"}:${header ?? ""}`;
  docs.forEach((doc, layerIndex) => {
    for (const section of doc.sections) {
      if (section.malformed !== undefined) {
        malformed.push(blockToEffective(section, doc.layer, { malformed: section.malformed }));
        continue;
      }
      const target = section.isArray ? arrays : plain;
      const key = slotKey(section.header, section.isArray);
      let list = target.get(key);
      if (list === undefined) {
        list = [];
        target.set(key, list);
        slotOrder.push(key);
      }
      list.push({ layerIndex, section });
    }
  });
  const sections: EffectiveSection[] = [];
  const rootKey = slotKey(null, false);
  if (plain.has(rootKey)) sections.push(mergePlainSections(null, plain.get(rootKey) ?? [], layers));
  for (const key of slotOrder) {
    if (key === rootKey) continue;
    const header = key.slice(2);
    if (key.startsWith("P:")) {
      sections.push(mergePlainSections(header, plain.get(key) ?? [], layers));
      continue;
    }
    const parts = arrays.get(key) ?? [];
    if (header === "fleet.job") {
      sections.push(...mergeFleetJobs(parts, layers));
      continue;
    }
    const top = Math.max(...parts.map((p) => p.layerIndex));
    for (const p of parts) {
      if (p.layerIndex === top) {
        sections.push(blockToEffective(p.section, layers[top] as LayerRef, {}));
      }
    }
  }
  sections.push(...malformed);
  return { sections };
}

/** Renders canonical TOML text (`\n` endings). Entry `raw` lines are emitted verbatim. */
export function renderEffectiveDoc(doc: EffectiveDoc): string {
  const blocks: string[] = [];
  for (const s of doc.sections) {
    const lines: string[] = [];
    if (s.malformed !== undefined) lines.push(s.malformed);
    else if (s.header !== null) lines.push(s.isArray ? `[[${s.header}]]` : `[${s.header}]`);
    for (const e of s.entries) lines.push(e.raw);
    for (const p of s.passthrough) lines.push(p.raw);
    if (lines.length > 0) blocks.push(lines.join("\n"));
  }
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}
