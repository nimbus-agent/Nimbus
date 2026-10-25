/**
 * V75 — `glossary_term.definition_local` (role packs P2, PR 2b, spec § 7.1).
 *
 * A term's definition and synonyms are written ONCE, from the snippets of its top sources at that
 * moment. Routing its search copy from the term's CURRENT occurrences alone would let a definition
 * written from a local-only item (a pack-mapped `ext_notes:highlight`, say) reach the remote
 * embedder after that item is deleted. `definition_local = 1` records that the stored definition
 * was written while a non-remote-eligible type contributed, and it pins the projection local until
 * the definition itself is rewritten; a statistics refresh never clears it.
 *
 * Existing rows default to 0, which is correct: before this column every definition was mined from
 * built-in, remote-eligible sources. Additive only.
 */
export const GLOSSARY_DEFINITION_LOCAL_V75_SQL = `
ALTER TABLE glossary_term ADD COLUMN definition_local INTEGER NOT NULL DEFAULT 0
  CHECK (definition_local IN (0,1));
`;
