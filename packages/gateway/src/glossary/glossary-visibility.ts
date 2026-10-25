import type { Database } from "bun:sqlite";

import { knownSourceTypes } from "../sources/source-catchup.ts";
import type { SourceMapping } from "../sources/source-mapping.ts";
import type { GlossarySets } from "./glossary-types.ts";

/**
 * Which glossary terms the effective source mapping lets a reader see (role packs P2, spec § 7).
 *
 * A mapping change never rewrites `glossary_term`: a term mined from a type that is later excluded
 * keeps its row, status, statistics and definition. Visibility is decided at read time instead,
 * against the mapping resolved for THAT read, so this module holds no state.
 */

/** True when every known type is effective, so no term can be hidden by the mapping. */
export function isFastPath(known: readonly string[], effective: readonly string[]): boolean {
  const eff = new Set(effective);
  return known.every((t) => eff.has(t));
}

/** The sets one read resolves against: the mapping's effective types and the pass's known types. */
export function glossarySets(db: Database, mapping: SourceMapping): GlossarySets {
  const effective = mapping.typesFor("glossary");
  const known = knownSourceTypes(db, "glossary");
  return { effective, known, fast: isFastPath(known, effective) };
}
