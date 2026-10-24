// Which built-in agents the catalog shows. Presentation only: nothing here gates a call,
// and no dispatcher, route, tool or scheduler reads it. Packs set `[agents] visible`
// (unioned); the owner's base and profile files add `show` / `hide`.

import type { ConfigSnapshot } from "../config/layered-config.ts";
import type { EffectiveEntry, LayerRef } from "../config/layered-merge.ts";
import { parseAgentNameList } from "../config/pack-settable.ts";
import { parseStringArray } from "../config/toml-primitives.ts";

export type AgentVisibilityOverride = {
  readonly agent: string;
  readonly visible: boolean;
  readonly layer: LayerRef;
};

export type AgentVisibility = {
  readonly visible: ReadonlySet<string>;
  readonly basis: "all" | "packs";
  /** Ids of the packs that set `visible`, low to high. */
  readonly packs: readonly string[];
  /** The agents a user layer decided, sorted by agent. */
  readonly overrides: readonly AgentVisibilityOverride[];
  readonly notes: readonly string[];
};

const AGENT_PREFIX = "agents.";

/** Strips ONE leading `agents.`. */
export function normaliseAgentName(raw: string): string {
  return raw.startsWith(AGENT_PREFIX) ? raw.slice(AGENT_PREFIX.length) : raw;
}

type LayerValue = { readonly layer: LayerRef; readonly valRaw: string };

/** The last entry for `key` carries the highest layer; its `shadowed` is the lower layers, low to high. */
function layerValues(entries: readonly EffectiveEntry[], key: string): readonly LayerValue[] {
  const last = entries.findLast((e) => e.key === key);
  if (last === undefined) return [];
  return [...last.shadowed, { layer: last.layer, valRaw: last.valRaw }];
}

const label = (l: LayerRef): string => `${l.kind}:${l.id}`;

type Names = { readonly layer: LayerRef; readonly names: readonly string[] };

/** Normalises, drops unknown names (noting each once) and dedupes. */
function knownNames(
  raw: readonly string[],
  layer: LayerRef,
  key: string,
  known: ReadonlySet<string>,
  notes: string[],
): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const name = normaliseAgentName(r);
    if (!known.has(name)) {
      const note = `unknown agent "${name}" in ${label(layer)} [agents] ${key}`;
      if (!notes.includes(note)) notes.push(note);
    } else if (!out.includes(name)) out.push(name);
  }
  return out;
}

function notArray(key: string, layer: LayerRef): string {
  return `[agents] ${key} in ${label(layer)} is not an array of agent names; ignored`;
}

function parseUserList(valRaw: string): readonly string[] | undefined {
  try {
    return parseStringArray(valRaw);
  } catch (err) {
    if (err instanceof TypeError) return undefined;
    throw err;
  }
}

function collectVisible(
  values: readonly LayerValue[],
  known: ReadonlySet<string>,
  notes: string[],
): Names[] {
  const lists: Names[] = [];
  for (const { layer, valRaw } of values) {
    if (layer.kind === "pack") {
      const parsed = parseAgentNameList(valRaw);
      if (parsed === undefined) notes.push(notArray("visible", layer));
      else lists.push({ layer, names: knownNames(parsed, layer, "visible", known, notes) });
    } else if (layer.kind === "base" || layer.kind === "profile") {
      notes.push(
        `[agents] visible in ${label(layer)} is ignored: only packs set it; use show and hide`,
      );
    }
  }
  return lists;
}

function collectUserList(
  values: readonly LayerValue[],
  key: "show" | "hide",
  known: ReadonlySet<string>,
  notes: string[],
): Names[] {
  const lists: Names[] = [];
  for (const { layer, valRaw } of values) {
    if (layer.kind !== "base" && layer.kind !== "profile") continue;
    const parsed = parseUserList(valRaw);
    if (parsed === undefined) notes.push(notArray(key, layer));
    else lists.push({ layer, names: knownNames(parsed, layer, key, known, notes) });
  }
  return lists;
}

const RANK: Readonly<Record<string, number>> = { base: 1, profile: 2 };

type Decision = { visible: boolean; layer: LayerRef };

/** Per agent the highest user layer naming it decides; within one layer `hide` beats `show`. */
function decide(shows: readonly Names[], hides: readonly Names[]): Map<string, Decision> {
  const decisions = new Map<string, Decision>();
  const apply = (lists: readonly Names[], visible: boolean): void => {
    for (const { layer, names } of lists) {
      for (const agent of names) {
        const cur = decisions.get(agent);
        const rank = RANK[layer.kind] ?? 0;
        const curRank = cur === undefined ? -1 : (RANK[cur.layer.kind] ?? 0);
        // A higher layer replaces; within the same layer a hide replaces a show.
        if (rank > curRank || (rank === curRank && !visible)) {
          decisions.set(agent, { visible, layer });
        }
      }
    }
  };
  apply(shows, true);
  apply(hides, false);
  return decisions;
}

/** Plain code-unit order (not locale order), so the overrides list is stable on every machine. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function resolveAgentVisibility(
  snapshot: Pick<ConfigSnapshot, "doc">,
  known: readonly string[],
): AgentVisibility {
  const section = snapshot.doc.sections.find((s) => s.header === "agents" && !s.isArray);
  if (section === undefined) {
    return { visible: new Set(known), basis: "all", packs: [], overrides: [], notes: [] };
  }
  const knownSet = new Set(known);
  const notes: string[] = [];
  const packLists = collectVisible(layerValues(section.entries, "visible"), knownSet, notes);
  const shows = collectUserList(layerValues(section.entries, "show"), "show", knownSet, notes);
  const hides = collectUserList(layerValues(section.entries, "hide"), "hide", knownSet, notes);

  const visible = new Set<string>(
    packLists.length === 0 ? known : packLists.flatMap((l) => l.names),
  );
  const overrides: AgentVisibilityOverride[] = [];
  for (const [agent, d] of decide(shows, hides)) {
    if (d.visible) visible.add(agent);
    else visible.delete(agent);
    overrides.push({ agent, visible: d.visible, layer: d.layer });
  }
  overrides.sort((a, b) => compareCodeUnits(a.agent, b.agent));
  return {
    visible,
    basis: packLists.length === 0 ? "all" : "packs",
    packs: packLists.map((l) => l.layer.id),
    overrides,
    notes,
  };
}

export function describeAgentVisibility(v: AgentVisibility): readonly string[] {
  const lines: string[] = [
    v.basis === "all"
      ? "agent visibility: all agents (no active pack sets [agents] visible)"
      : `agent visibility: the agents listed by packs ${v.packs.join(", ")}`,
  ];
  for (const o of v.overrides) {
    lines.push(`agent "${o.agent}" is ${o.visible ? "shown" : "hidden"} by ${label(o.layer)}`);
  }
  lines.push(...v.notes);
  return lines;
}
