import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { SweepKind } from "../config/fleet-toml.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import type { SweepSubjectParam } from "./fleet-sweep-support.ts";

export interface SweepSubject {
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface SweepEnumeration {
  readonly subjects: readonly SweepSubject[];
  /** Why the list is empty; null whenever it is not. Surfaced by `fleet.list`. */
  readonly emptyReason: string | null;
}

export interface SweepEnumerateRequest {
  readonly kind: SweepKind;
  readonly param: SweepSubjectParam;
  readonly pathPrefix: string | null;
}

export type FleetSweepEnumerate = (req: SweepEnumerateRequest) => SweepEnumeration;

export interface SweepSources {
  readonly db: Database;
  /** Called per enumeration, so a root added since boot is swept on the next run. */
  readonly roots: () => readonly string[];
  readonly serviceIds: () => readonly string[];
}

function finish(subjects: SweepSubject[], reasonIfEmpty: string): SweepEnumeration {
  subjects.sort((a, b) => codeUnitCompare(a.key, b.key));
  return { subjects, emptyReason: subjects.length === 0 ? reasonIfEmpty : null };
}

/** `file:<root>:<rel>` / `dir:<root>:<rel>` → root + rel, matched against CONFIGURED roots only. */
function matchOwnershipNode(
  type: string,
  externalId: string,
  rootsLongestFirst: readonly string[],
): { root: string; rel: string } | null {
  const tag = type === "source_file" ? "file" : "dir";
  for (const root of rootsLongestFirst) {
    const prefix = `${tag}:${root}:`;
    if (externalId.startsWith(prefix)) return { root, rel: externalId.slice(prefix.length) };
  }
  return null;
}

/**
 * The ownership pass's OWN `source_file`/`directory` nodes (spec § 5.2) — exactly what the agent can
 * answer, distinct by construction. The key reuses the node's external id VERBATIM: normalising it
 * (e.g. lower-casing a drive letter) would make a key disagree with the node it names. The param is
 * the ABSOLUTE path, so `resolveOwnershipPath` resolves against exactly one root.
 */
export function enumeratePaths(
  db: Database,
  roots: readonly string[],
  param: SweepSubjectParam,
  pathPrefix: string | null,
): SweepEnumeration {
  if (roots.length === 0) {
    return {
      subjects: [],
      emptyReason:
        "no git-aware filesystem roots are configured, so the ownership pass has no nodes to sweep",
    };
  }
  const rows = db
    .query(`SELECT type, external_id FROM graph_entity WHERE type IN ('source_file', 'directory')`)
    .all() as ReadonlyArray<{ type: string; external_id: string }>;
  const longestFirst = [...roots].sort((a, b) => b.length - a.length);
  const subjects: SweepSubject[] = [];
  for (const r of rows) {
    const hit = matchOwnershipNode(r.type, r.external_id, longestFirst);
    if (hit === null) continue;
    if (pathPrefix !== null && !hit.rel.startsWith(pathPrefix)) continue;
    subjects.push({
      key: `paths:${r.external_id}`,
      params: { [param]: hit.rel === "" ? hit.root : join(hit.root, hit.rel) },
    });
  }
  let reason = "no ownership node lies under a configured git-aware root";
  if (rows.length === 0)
    reason = "the ownership pass has not written any file or directory nodes yet";
  else if (pathPrefix !== null) reason = `no ownership node lies under path_prefix "${pathPrefix}"`;
  return finish(subjects, reason);
}

/** `loadNimbusServiceConfigsFromConfigDir` keys — the loader agents resolve `service` against. */
export function enumerateServices(
  serviceIds: readonly string[],
  param: SweepSubjectParam,
): SweepEnumeration {
  return finish(
    serviceIds.map((id) => ({ key: `services:${id}`, params: { [param]: id } })),
    "no services are configured ([ci.service.<id>] or [metrics.dora.<id>])",
  );
}

/** `syncCodeSymbolGraph` writes symbol labels as `<name> — <file>`. */
const SYMBOL_LABEL_SEPARATOR = " — ";

/**
 * DISTINCT symbol labels. A label collision (same name + file across kind or root) is ONE subject —
 * the stated bound in spec § 10; the agent's exact-label lookup briefs one of the colliding entities.
 */
export function enumerateSymbols(
  db: Database,
  param: SweepSubjectParam,
  pathPrefix: string | null,
): SweepEnumeration {
  const rows = db
    .query(`SELECT DISTINCT label FROM graph_entity WHERE type = 'symbol'`)
    .all() as ReadonlyArray<{ label: string }>;
  const subjects: SweepSubject[] = [];
  for (const { label } of rows) {
    if (pathPrefix !== null) {
      const at = label.lastIndexOf(SYMBOL_LABEL_SEPARATOR);
      // A label with no separator has no file part to match. `syncCodeSymbolGraph` is the ONLY
      // writer of `symbol` entities and always writes the separator, so this arm is not reachable
      // from production data; if it ever is, EXCLUDING the symbol from a path-filtered sweep is the
      // honest answer. Falling back to the whole label would match the symbol NAME against a path
      // prefix and admit a symbol whose file is unknown.
      const file = at === -1 ? "" : label.slice(at + SYMBOL_LABEL_SEPARATOR.length);
      if (!file.startsWith(pathPrefix)) continue;
    }
    subjects.push({ key: `symbols:${label}`, params: { [param]: label } });
  }
  return finish(
    subjects,
    rows.length === 0
      ? "no code symbols are indexed (enable code_index on a [[filesystem.roots]] entry)"
      : `no code symbol's file lies under path_prefix "${pathPrefix ?? ""}"`,
  );
}

/** Consolidated terms only; the param is `display_term`, which the agent normalises to `term_key`. */
export function enumerateTerms(db: Database, param: SweepSubjectParam): SweepEnumeration {
  const rows = db
    .query(`SELECT term_key, display_term FROM glossary_term WHERE status = 'consolidated'`)
    .all() as ReadonlyArray<{ term_key: string; display_term: string }>;
  return finish(
    rows.map((r) => ({ key: `terms:${r.term_key}`, params: { [param]: r.display_term } })),
    "no consolidated glossary terms yet",
  );
}

export function buildFleetSweepEnumerate(src: SweepSources): FleetSweepEnumerate {
  return (req) => {
    switch (req.kind) {
      case "paths":
        return enumeratePaths(src.db, src.roots(), req.param, req.pathPrefix);
      case "services":
        return enumerateServices(src.serviceIds(), req.param);
      case "symbols":
        return enumerateSymbols(src.db, req.param, req.pathPrefix);
      case "terms":
        return enumerateTerms(src.db, req.param);
      default: {
        const unreachable: never = req.kind;
        throw new Error(`unknown sweep kind: ${String(unreachable)}`);
      }
    }
  };
}
