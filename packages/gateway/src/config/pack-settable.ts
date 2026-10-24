// The pack-settable allowlist and the whole-fragment check. Pure: it parses text and
// reports problems; it reads no files. A pack fragment may set only the keys listed
// here; one bad line refuses the whole fragment.

import { type DocLine, type DocSection, parseLayerDoc } from "./layered-merge.ts";
import { parseBool, parseIntDec, parseString } from "./toml-primitives.ts";

/**
 * A pack id is also a file name (`<id>.toml`), so the Windows reserved device names are refused
 * as whole ids; `console`, `nul1` and `com10` are ordinary names and stay accepted.
 */
export const PACK_ID_RE = /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9_-]{0,63}$/;

/** Bounds a tampered fragment file. Measured in UTF-8 bytes. */
export const PACK_FRAGMENT_MAX_BYTES = 65_536;

/** How the consumer of a key sees a change to it (per-call read vs. reactive subscription). */
export type PackConsumerMode = "per-call" | "reactive";

export type PackScalar = boolean | number;

export type PackSettableKey = {
  readonly section: string;
  readonly key: string;
  readonly consumer: PackConsumerMode;
  readonly why: string;
  readonly expect: string;
  readonly parse: (valRaw: string) => PackScalar | undefined;
};

const PLAIN_DECIMAL_RE = /^[+-]?\d+(?:\.\d+)?$/;

function parseNonNegInt(min: number): (valRaw: string) => number | undefined {
  return (valRaw) => {
    const n = parseIntDec(valRaw);
    return n !== undefined && n >= min ? n : undefined;
  };
}

function parseUnitInterval(valRaw: string): number | undefined {
  const t = valRaw.trim();
  if (!PLAIN_DECIMAL_RE.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

export const PACK_SETTABLE_KEYS: readonly PackSettableKey[] = [
  {
    section: "fleet",
    key: "enabled",
    consumer: "reactive",
    why: "fleet master switch; the owner's own file still overrides it",
    expect: "true or false",
    parse: parseBool,
  },
  {
    section: "fleet",
    key: "min_idle_seconds",
    consumer: "reactive",
    why: "how long the host must be idle before an unattended run starts",
    expect: "an integer >= 0",
    parse: parseNonNegInt(0),
  },
  {
    section: "fleet",
    key: "require_ac_power",
    consumer: "reactive",
    why: "whether unattended runs wait for AC power",
    expect: "true or false",
    parse: parseBool,
  },
  {
    section: "fleet",
    key: "retention_days",
    consumer: "reactive",
    why: "how long fleet briefs are kept before pruning",
    expect: "an integer >= 1",
    parse: parseNonNegInt(1),
  },
  {
    section: "decisions",
    key: "min_confidence",
    consumer: "per-call",
    why: "confidence floor below which a decision is not shown",
    expect: "a plain decimal between 0 and 1",
    parse: parseUnitInterval,
  },
];

/** A name in an `[agents]` list: a short agent name, optionally written `agents.<name>`. */
export const AGENT_NAME_IN_LIST_RE = /^(?:agents\.)?[a-z][A-Za-z]{0,63}$/;

const AGENT_LIST_MAX = 64;

/**
 * Strict parse of `["a", "b"]`. Deliberately not `parseString`, which accepts unquoted tokens.
 * Names are returned as written; normalisation belongs to the consumer.
 */
export function parseAgentNameList(valRaw: string): readonly string[] | undefined {
  const t = valRaw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return undefined;
  const inner = t.slice(1, -1).trim();
  if (inner === "" || inner.endsWith(",")) return undefined;
  const parts = inner.split(",");
  if (parts.length > AGENT_LIST_MAX) return undefined;
  const names: string[] = [];
  for (const part of parts) {
    const p = part.trim();
    if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return undefined;
    const name = p.slice(1, -1);
    if (!AGENT_NAME_IN_LIST_RE.test(name)) return undefined;
    names.push(name);
  }
  return names;
}

export type PackSettableList = {
  readonly section: string;
  readonly key: string;
  readonly consumer: PackConsumerMode;
  readonly why: string;
  readonly expect: string;
  readonly parse: (valRaw: string) => readonly string[] | undefined;
};

/** List-valued keys. They never enter `scalars`, so two packs setting one is a union, not a conflict. */
export const PACK_SETTABLE_LISTS: readonly PackSettableList[] = [
  {
    section: "agents",
    key: "visible",
    consumer: "per-call",
    why: "which agents the catalog shows; packs union, the owner's show/hide decide per agent",
    expect: 'a non-empty array of agent names, e.g. ["decisions", "standup"]',
    parse: parseAgentNameList,
  },
];

export const PACK_SETTABLE_ARRAYS: readonly {
  readonly header: "fleet.job";
  readonly consumer: "reactive";
  readonly why: string;
}[] = [{ header: "fleet.job", consumer: "reactive", why: "scheduled fleet jobs, merged by name" }];

/** Returns the problems with the rendered `[[fleet.job]]` blocks; empty when fine. */
export type PackJobChecker = (jobsText: string) => readonly string[];

export type PackFragmentCheck =
  | {
      readonly ok: true;
      readonly scalars: ReadonlyMap<string, PackScalar>;
      readonly lists: ReadonlyMap<string, readonly string[]>;
      readonly jobNames: readonly string[];
    }
  | { readonly ok: false; readonly problems: readonly string[] };

type JobBlock = { readonly name: string; readonly raw: readonly string[] };

function checkJobBlock(section: DocSection, problems: string[]): JobBlock | undefined {
  const before = problems.length;
  let name: string | undefined;
  const seen = new Set<string>();
  const raws: string[] = [];
  for (const line of section.lines) {
    raws.push(line.raw);
    if (line.kind === "passthrough") {
      problems.push(`[[fleet.job]] has a line that is not "key = value": ${line.raw.trim()}`);
      continue;
    }
    if (seen.has(line.key)) {
      problems.push(`[[fleet.job]] sets ${line.key} twice`);
      continue;
    }
    seen.add(line.key);
    if (line.key === "name") name = parseString(line.valRaw);
  }
  if (name === undefined || name === "") {
    problems.push("[[fleet.job]] needs a non-empty name");
    return undefined;
  }
  return problems.length === before ? { name, raw: raws } : undefined;
}

function checkPlainSection(
  section: DocSection,
  header: string,
  scalars: Map<string, PackScalar>,
  lists: Map<string, readonly string[]>,
  seenKeys: Set<string>,
  problems: string[],
): void {
  const keys = PACK_SETTABLE_KEYS.filter((k) => k.section === header);
  const listKeys = PACK_SETTABLE_LISTS.filter((k) => k.section === header);
  if (keys.length === 0 && listKeys.length === 0 && section.lines.length === 0) {
    problems.push(`[${header}] is not pack-settable`);
    return;
  }
  for (const line of section.lines as readonly DocLine[]) {
    if (line.kind === "passthrough") {
      problems.push(`[${header}] has a line that is not "key = value": ${line.raw.trim()}`);
      continue;
    }
    const spec = keys.find((k) => k.key === line.key);
    const listSpec = spec === undefined ? listKeys.find((k) => k.key === line.key) : undefined;
    if (spec === undefined && listSpec === undefined) {
      problems.push(`[${header}] ${line.key} is not pack-settable`);
      continue;
    }
    const id = `${header}.${line.key}`;
    if (seenKeys.has(id)) problems.push(`[${header}] sets ${line.key} twice`);
    seenKeys.add(id);
    if (listSpec !== undefined) {
      const items = listSpec.parse(line.valRaw);
      if (items === undefined) {
        problems.push(`[${header}] ${line.key} = ${line.valRaw}: expected ${listSpec.expect}`);
      } else {
        lists.set(id, items);
      }
      continue;
    }
    if (spec === undefined) continue;
    const value = spec.parse(line.valRaw);
    if (value === undefined) {
      problems.push(`[${header}] ${line.key} = ${line.valRaw}: expected ${spec.expect}`);
    } else {
      scalars.set(id, value);
    }
  }
}

export function checkPackFragment(text: string, checkJobs: PackJobChecker): PackFragmentCheck {
  if (Buffer.byteLength(text, "utf8") > PACK_FRAGMENT_MAX_BYTES) {
    return {
      ok: false,
      problems: [`fragment is larger than ${PACK_FRAGMENT_MAX_BYTES} bytes`],
    };
  }
  const doc = parseLayerDoc({ kind: "pack", id: "check", path: "" }, text);
  const problems: string[] = [];
  const scalars = new Map<string, PackScalar>();
  const lists = new Map<string, readonly string[]>();
  const seenKeys = new Set<string>();
  const blocks: JobBlock[] = [];
  for (const section of doc.sections) {
    if (section.malformed !== undefined) {
      problems.push(`malformed table header: ${section.malformed.trim()}`);
      continue;
    }
    if (section.header === null) {
      problems.push("root-level keys are not pack-settable");
      continue;
    }
    if (section.isArray) {
      if (!PACK_SETTABLE_ARRAYS.some((a) => a.header === section.header)) {
        problems.push(`[[${section.header}]] is not pack-settable`);
        continue;
      }
      const block = checkJobBlock(section, problems);
      if (block !== undefined) blocks.push(block);
      continue;
    }
    checkPlainSection(section, section.header, scalars, lists, seenKeys, problems);
  }
  if (blocks.length > 0) {
    const jobsText = blocks.map((b) => `[[fleet.job]]\n${b.raw.join("\n")}\n`).join("");
    problems.push(...checkJobs(jobsText));
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, scalars, lists, jobNames: blocks.map((b) => b.name) };
}
