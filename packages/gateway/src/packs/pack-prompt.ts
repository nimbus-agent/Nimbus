// The text the owner approves for `pack.install`, and the diff an update shows. Pure: it formats
// what it is handed and reads no file. Every manifest-sourced string passes through `visibleText`
// first, because a local-file pack is unreviewed text and the prompt IS the boundary: an invisible
// or bidi-control character must be shown as an escape, never rendered.

import type { RolePackManifest } from "@nimbus-dev/registry-format";
import { checkPackFragment } from "../config/pack-settable.ts";
import { FORMAT_INVISIBLE_RANGES } from "../mcp-sink/invisible-text.ts";
import type { PackSource } from "./pack-record.ts";

const LF = 0x0a;
const TAB = 0x09;

function isHidden(cp: number): boolean {
  if (cp < 0x20) return cp !== LF && cp !== TAB;
  return FORMAT_INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function escapeCodePoint(cp: number): string {
  const hex = cp.toString(16).toUpperCase();
  return cp > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
}

/** C0 controls except LF/TAB, DEL and every format-invisible range, shown as `\uXXXX` / `\u{X}`. */
export function visibleText(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isHidden(cp) ? escapeCodePoint(cp) : ch;
  }
  return out;
}

export type PromptScalar = {
  readonly key: string;
  readonly packValue: string;
  readonly current: string | undefined;
  readonly currentLayer: string | undefined;
  readonly userOverrides: boolean;
};

export type PackDiff = {
  readonly scalars: {
    readonly added: string[];
    readonly removed: string[];
    readonly changed: string[];
  };
  readonly visible: { readonly added: string[]; readonly removed: string[] };
  readonly jobs: {
    readonly added: string[];
    readonly removed: string[];
    readonly changed: string[];
  };
  readonly connectors: { readonly added: string[]; readonly removed: string[] };
  readonly metadataOnly: boolean;
};

const NO_JOB_CHECK = (): readonly string[] => [];
const JOB_NAME_RE = /^\s*name\s*=\s*"(.*)"\s*$/;
const VISIBLE_KEY = "agents.visible";

/** `[[fleet.job]]` blocks keyed by name; a block runs from its header to the next header or EOF. */
function jobBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let lines: string[] | undefined;
  const close = (): void => {
    if (lines === undefined) return;
    const name = lines.map((l) => JOB_NAME_RE.exec(l)?.[1]).find((n) => n !== undefined);
    if (name !== undefined) blocks.set(name, lines.join("\n").trim());
    lines = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "[[fleet.job]]") {
      close();
      lines = [line.trim()];
    } else if (line.trimStart().startsWith("[")) {
      close();
    } else if (lines !== undefined) {
      lines.push(line);
    }
  }
  close();
  return blocks;
}

function fragmentParts(m: RolePackManifest): {
  scalars: ReadonlyMap<string, string>;
  visible: readonly string[];
} {
  const r = checkPackFragment(m.defaults, NO_JOB_CHECK);
  if (!r.ok) return { scalars: new Map(), visible: [] };
  const scalars = new Map<string, string>();
  for (const [k, v] of r.scalars) scalars.set(k, String(v));
  return { scalars, visible: r.lists.get(VISIBLE_KEY) ?? [] };
}

function setDiff<T>(prev: Iterable<T>, next: Iterable<T>): { added: T[]; removed: T[] } {
  const p = new Set(prev);
  const n = new Set(next);
  return { added: [...n].filter((x) => !p.has(x)), removed: [...p].filter((x) => !n.has(x)) };
}

export function diffPacks(prev: RolePackManifest, next: RolePackManifest): PackDiff {
  const a = fragmentParts(prev);
  const b = fragmentParts(next);
  const s = setDiff(a.scalars.keys(), b.scalars.keys());
  const changedScalars = [...b.scalars].filter(
    ([k, v]) => a.scalars.has(k) && a.scalars.get(k) !== v,
  );
  const pj = jobBlocks(prev.defaults);
  const nj = jobBlocks(next.defaults);
  const j = setDiff(pj.keys(), nj.keys());
  return {
    scalars: { added: s.added, removed: s.removed, changed: changedScalars.map(([k]) => k) },
    visible: setDiff(a.visible, b.visible),
    jobs: {
      ...j,
      changed: [...nj].filter(([k, v]) => pj.has(k) && pj.get(k) !== v).map(([k]) => k),
    },
    connectors: setDiff(prev.suggestedConnectors, next.suggestedConnectors),
    metadataOnly: prev.defaults === next.defaults,
  };
}

export type PackPromptInput = {
  readonly manifest: RolePackManifest;
  readonly source: PackSource;
  /** `installed` is a summary of a pack already in place (`pack show`), never a prompt. */
  readonly mode: "install" | "update" | "repair" | "installed";
  readonly diff?: PackDiff;
  /** Update mode only: the layer file on disk differs from the previously approved defaults. */
  readonly layerEdited?: boolean;
  readonly scalars: readonly PromptScalar[];
  readonly visibleAgents: readonly string[];
  readonly jobs: readonly {
    readonly name: string;
    readonly agent: string;
    readonly intervalSeconds: number;
    readonly userReplaces: boolean;
  }[];
  readonly connectors: readonly { readonly id: string; readonly configured: boolean }[];
};

function section(title: string, items: readonly string[]): string[] {
  return [title, ...(items.length === 0 ? ["  none"] : items.map((i) => `  ${i}`)), ""];
}

function scalarRow(s: PromptScalar): string {
  const cur =
    s.current === undefined
      ? "unset"
      : `current ${visibleText(s.current)} (${visibleText(s.currentLayer ?? "unknown")})`;
  const mark = s.userOverrides ? " (your file overrides this)" : "";
  return `${visibleText(s.key)} = ${visibleText(s.packValue)}, ${cur}${mark}`;
}

function jobRow(j: PackPromptInput["jobs"][number]): string {
  const mark = j.userReplaces ? " (replaced by your own job of this name)" : "";
  return `${visibleText(j.name)}: ${visibleText(j.agent)} every ${String(j.intervalSeconds)}s${mark}`;
}

function removedRows(names: readonly string[]): string[] {
  return names.map((n) => `removed: ${visibleText(n)}`);
}

function fleetEnabledLine(scalars: readonly PromptScalar[]): string {
  const s = scalars.find((x) => x.key === "fleet.enabled");
  if (s === undefined) return "[fleet] enabled: not set by this pack";
  const effective = s.userOverrides ? (s.current ?? s.packValue) : s.packValue;
  return `[fleet] enabled: ${visibleText(effective)}`;
}

function headerLines(i: PackPromptInput): string[] {
  const m = i.manifest;
  const src = i.source.kind === "bundled" ? "bundled" : `local file ${visibleText(i.source.path)}`;
  const title = `role pack ${visibleText(m.name)} (${visibleText(m.id)}) version ${visibleText(m.version)}`;
  const lines = [
    i.mode === "installed"
      ? `Installed: ${title}`
      : `${{ install: "Install", update: "Update", repair: "Repair" }[i.mode]} ${title}`,
    `Source: ${src}`,
    visibleText(m.description),
    "",
  ];
  if (i.mode === "repair") {
    lines.push(
      "The pack's config layer on disk no longer matches the pack you approved. Installing again rewrites it.",
      "",
    );
  }
  return lines;
}

function installSections(i: PackPromptInput): string[] {
  return [
    ...section("Config defaults:", i.scalars.map(scalarRow)),
    ...section("Visible agents:", i.visibleAgents.map(visibleText)),
    ...section("Overnight jobs:", [...i.jobs.map(jobRow), ...fleetNote(i)]),
    ...section(
      "Suggested connectors:",
      i.connectors.map(
        (c) => `${visibleText(c.id)}: ${c.configured ? "configured" : "not configured"}`,
      ),
    ),
  ];
}

function fleetNote(i: PackPromptInput): string[] {
  return i.jobs.length === 0 ? [] : [fleetEnabledLine(i.scalars)];
}

function updateSections(i: PackPromptInput, d: PackDiff): string[] {
  const touched = new Set([...d.scalars.added, ...d.scalars.changed]);
  const touchedJobs = new Set([...d.jobs.added, ...d.jobs.changed]);
  const connectorRows = [
    ...d.connectors.added.map((c) => `added: ${visibleText(c)}`),
    ...removedRows(d.connectors.removed),
  ];
  return [
    ...section("Config defaults:", [
      ...i.scalars.filter((s) => touched.has(s.key)).map(scalarRow),
      ...removedRows(d.scalars.removed),
    ]),
    ...section("Visible agents:", [
      ...d.visible.added.map((a) => `added: ${visibleText(a)}`),
      ...removedRows(d.visible.removed),
    ]),
    ...section("Overnight jobs:", [
      ...i.jobs.filter((j) => touchedJobs.has(j.name)).map(jobRow),
      ...removedRows(d.jobs.removed),
      ...fleetNote(i),
    ]),
    ...section("Suggested connectors:", connectorRows),
  ];
}

export function renderPackPrompt(input: PackPromptInput): string {
  const out = headerLines(input);
  if (input.mode === "update") {
    if (input.diff === undefined) throw new Error("renderPackPrompt: update mode needs a diff");
    if (input.layerEdited === true) {
      out.push("Your edits to this pack's layer file will be replaced.", "");
    }
    if (input.diff.metadataOnly) out.push("This update has no config changes.", "");
    out.push(...updateSections(input, input.diff));
  } else {
    out.push(...installSections(input));
  }
  const defaults = input.manifest.defaults;
  if (defaults === "") {
    out.push("This pack writes no config.");
  } else {
    out.push("Full config text:", visibleText(defaults));
  }
  out.push(
    "",
    `This pack changes no credentials, no network reach and no approvals, and your nimbus.toml is not edited. Undo it with: nimbus pack remove ${visibleText(input.manifest.id)}`,
  );
  return out.join("\n");
}
