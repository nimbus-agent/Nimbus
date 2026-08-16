import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import type { GlossaryTerm } from "./glossary-types.ts";

const SERVICE = "nimbus";
const TYPE = "glossary_term";

/** `upsertIndexedItem` clips body_preview at 512 chars — mirror that budget here. */
const BODY_LIMIT = 512;
const SYNONYM_PREFIX = "Also known as: ";

export function glossaryItemExternalId(termKey: string): string {
  return `glossary:${termKey}`;
}

/**
 * Builds the indexed body.
 *
 * `item_fts` indexes only `title` and `body` — metadata JSON is
 * invisible to both FTS and the embedding pipeline. Synonyms therefore have to
 * live in the body text, or `ask "what does Change Data Record mean?"` finds
 * nothing while the acronym query succeeds — exactly backwards, since the
 * person who needs the glossary is the one who does not know the acronym yet.
 *
 * The synonym line is reserved FIRST and the definition truncated into what is
 * left, because `upsertIndexedItem` clips at 512 chars and a naive append would
 * be silently cut away.
 */
export function buildProjectedBody(definition: string, synonyms: readonly string[]): string {
  if (synonyms.length === 0) return definition.slice(0, BODY_LIMIT);

  const synLine = `${SYNONYM_PREFIX}${synonyms.join(", ")}`.slice(0, BODY_LIMIT);
  const room = BODY_LIMIT - synLine.length - 2; // 2 = the "\n\n" separator
  if (room <= 0) return synLine;
  return `${definition.slice(0, room)}\n\n${synLine}`;
}

export function projectTerm(db: Database, term: GlossaryTerm, nowMs: number): string {
  if (term.definition === null) {
    throw new Error(`cannot project glossary term "${term.termKey}" without a definition`);
  }
  const externalId = glossaryItemExternalId(term.termKey);
  upsertIndexedItem(db, {
    service: SERVICE,
    type: TYPE,
    externalId,
    title: term.displayTerm,
    bodyPreview: buildProjectedBody(term.definition, term.synonyms),
    url: null,
    canonicalUrl: null,
    modifiedAt: term.lastSeenAt,
    syncedAt: nowMs,
    metadata: {
      source: "glossary",
      definitions: [term.definition],
      definitionSource: term.definitionSource,
      synonyms: term.synonyms,
      nearMisses: term.nearMisses,
      topSources: term.topSources,
      firstSeenAt: term.firstSeenAt,
      lastSeenAt: term.lastSeenAt,
      docFreq: term.docFreq,
      generatedAt: nowMs,
    },
  });
  return itemPrimaryKey(SERVICE, externalId);
}

/**
 * Removes a term from the searchable index. Called when a term is demoted or
 * vetoed: a stale definition surfacing in search after the term was rejected
 * would be worse than no glossary at all.
 */
export function unprojectTerm(db: Database, termKey: string): void {
  dbRun(db, "DELETE FROM item WHERE id = ?", [
    itemPrimaryKey(SERVICE, glossaryItemExternalId(termKey)),
  ]);
}
