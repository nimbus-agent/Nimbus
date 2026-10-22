// `config explain`: where each effective value comes from. Reads the layered snapshot
// (pack -> base -> profile) and puts a set, effective environment override on top.

import { processEnvGet } from "../platform/env-access.ts";
import { CONFIG_ENV_OVERRIDES, isPolicyConstrainedPath } from "./config-env-overrides.ts";
import type { LayeredConfig } from "./layered-config.ts";
import {
  type EffectiveEntry,
  type EffectiveSection,
  type LayerRef,
  UNPARSED_SECTION_HEADER,
} from "./layered-merge.ts";
import { parseString } from "./toml-primitives.ts";

export type ExplainSource =
  | { readonly kind: "layer"; readonly layer: LayerRef }
  | { readonly kind: "env"; readonly envVar: string };

export type ExplainEntry = {
  readonly path: string;
  readonly value: string;
  readonly source: ExplainSource;
  readonly shadowed: readonly { readonly source: ExplainSource; readonly value: string }[];
};

export type ExplainResult = {
  readonly runningProfile: string;
  readonly markerProfile: string;
  readonly layers: readonly { readonly layer: LayerRef; readonly exists: boolean }[];
  readonly entries: readonly ExplainEntry[];
  readonly blocks?: readonly {
    readonly header: string;
    readonly layer: LayerRef;
    readonly entries: readonly ExplainEntry[];
  }[];
  readonly policyMayRestrict: boolean;
  readonly sectionFallback?: string;
  readonly notes: readonly string[];
};

type EnvGet = (k: string) => string | undefined;

/** Splits on `.` outside double quotes; quotes stay in the segments. */
function splitPath(path: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of path) {
    if (ch === '"') quoted = !quoted;
    if (ch === "." && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const unquote = (s: string): string => s.replaceAll('"', "");

function entryPath(header: string | null, key: string): string {
  return header === null ? key : `${header}.${key}`;
}

function toExplainEntry(header: string | null, e: EffectiveEntry): ExplainEntry {
  return {
    path: entryPath(header, e.key),
    value: e.valRaw,
    source: { kind: "layer", layer: e.layer },
    // Newest shadowed value first.
    shadowed: [...e.shadowed].reverse().map((s) => ({
      source: { kind: "layer" as const, layer: s.layer },
      value: s.valRaw,
    })),
  };
}

function applyEnv(entry: ExplainEntry, env: EnvGet, notes: string[]): ExplainEntry {
  for (const o of CONFIG_ENV_OVERRIDES) {
    if (unquote(o.path) !== unquote(entry.path)) continue;
    const raw = env(o.envVar);
    if (raw === undefined) continue;
    const effective = o.effective(raw);
    if (effective === undefined) {
      notes.push(`${o.envVar} is set to "${raw}" but does not override this value`);
      continue;
    }
    return {
      path: entry.path,
      value: effective,
      source: { kind: "env", envVar: o.envVar },
      shadowed: [{ source: entry.source, value: entry.value }, ...entry.shadowed],
    };
  }
  return entry;
}

/** An override for a path no file sets: the env value alone is the source. */
function envOnlyEntry(path: string, env: EnvGet): ExplainEntry | undefined {
  for (const o of CONFIG_ENV_OVERRIDES) {
    if (unquote(o.path) !== unquote(path)) continue;
    const raw = env(o.envVar);
    const effective = raw === undefined ? undefined : o.effective(raw);
    if (effective !== undefined) {
      return {
        path: o.path,
        value: effective,
        source: { kind: "env", envVar: o.envVar },
        shadowed: [],
      };
    }
  }
  return undefined;
}

function blockFor(
  s: EffectiveSection,
  env: EnvGet,
  notes: string[],
): { header: string; layer: LayerRef; entries: ExplainEntry[] } | undefined {
  if (s.header === null || s.blockLayer === undefined) return undefined;
  return {
    header: s.header,
    layer: s.blockLayer,
    entries: s.entries.map((e) => applyEnv(toExplainEntry(s.header, e), env, notes)),
  };
}

function blockName(s: EffectiveSection): string | undefined {
  let name: string | undefined;
  for (const e of s.entries) if (e.key === "name") name = parseString(e.valRaw);
  return name;
}

/** Picks the plain section for `segs`: longest header prefix, exact quoted match on a tie. */
function resolvePlain(
  plain: readonly EffectiveSection[],
  segs: readonly string[],
): { section: EffectiveSection; key: string } | undefined {
  for (let k = segs.length - 1; k >= 0; k -= 1) {
    const rawPrefix = segs.slice(0, k).join(".");
    const matches = plain.filter((s) =>
      k === 0 ? s.header === null : s.header !== null && unquote(s.header) === unquote(rawPrefix),
    );
    if (matches.length === 0) continue;
    const section = matches.find((s) => s.header === rawPrefix) ?? matches[0];
    if (section !== undefined) return { section, key: segs.slice(k).join(".") };
  }
  return undefined;
}

export function explainConfig(
  reader: LayeredConfig,
  path: string | undefined,
  env: EnvGet = processEnvGet,
): ExplainResult {
  const snap = reader.snapshot();
  const notes: string[] = [];
  const sections = snap.doc.sections.filter(
    (s) => s.malformed === undefined && s.header !== UNPARSED_SECTION_HEADER,
  );
  const plain = sections.filter((s) => !s.isArray);
  const arrays = sections.filter((s) => s.isArray);
  const entries: ExplainEntry[] = [];
  const blocks: { header: string; layer: LayerRef; entries: ExplainEntry[] }[] = [];

  if (path === undefined) {
    for (const s of plain) {
      for (const e of s.entries) entries.push(applyEnv(toExplainEntry(s.header, e), env, notes));
    }
    for (const o of CONFIG_ENV_OVERRIDES) {
      if (entries.some((e) => unquote(e.path) === o.path)) continue;
      const only = envOnlyEntry(o.path, env);
      if (only !== undefined) entries.push(only);
    }
    for (const s of arrays) {
      const b = blockFor(s, env, notes);
      if (b !== undefined) blocks.push(b);
    }
  } else {
    const segs = splitPath(path);
    const wanted = unquote(segs.join("."));
    const hit = resolvePlain(plain, segs);
    if (hit !== undefined) {
      const matching = hit.section.entries.filter((e) => unquote(e.key) === unquote(hit.key));
      const last = matching.at(-1);
      if (last !== undefined) {
        entries.push(applyEnv(toExplainEntry(hit.section.header, last), env, notes));
      }
    }
    if (entries.length === 0) {
      const only = envOnlyEntry(path, env);
      if (only !== undefined) entries.push(only);
    }
    for (const s of arrays) {
      if (s.header === null) continue;
      const h = unquote(s.header);
      const whole = h === wanted;
      const byName = wanted.startsWith(`${h}.`) && blockName(s) === wanted.slice(h.length + 1);
      if (whole || byName) {
        const b = blockFor(s, env, notes);
        if (b !== undefined) blocks.push(b);
      }
    }
    if (entries.length === 0 && blocks.length === 0) {
      notes.push(`no layer sets ${path}; the code default applies`);
    }
  }

  const running = reader.profile.name;
  const marker = reader.markerProfile();
  if (marker !== running) {
    notes.push(`profile switched to "${marker}" on disk; restart the gateway to apply`);
  }
  const policyMayRestrict =
    path === undefined
      ? entries.some((e) => isPolicyConstrainedPath(e.path))
      : isPolicyConstrainedPath(path) || isPolicyConstrainedPath(unquote(path));
  return {
    runningProfile: running,
    markerProfile: marker,
    layers: snap.layers,
    entries,
    ...(blocks.length > 0 ? { blocks } : {}),
    policyMayRestrict,
    notes,
  };
}
