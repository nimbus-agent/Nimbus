/**
 * V54 — namespace `graph_entity.metadata` for the six co-owned entity types.
 *
 * The type list is kept in step with `CO_OWNED_ENTITY_TYPES`
 * (`graph/relationship-graph.ts`) BY HAND, not imported: migration SQL is a frozen historical
 * artefact — it must keep migrating exactly the rows it migrated on the day it ran, so it
 * cannot follow a constant that a later commit widens. A type added to
 * `CO_OWNED_ENTITY_TYPES` after V54 ships therefore needs its own migration, not an edit here.
 * `workspace` and `repo` were added to this filter while V54 was still unshipped, which is the
 * only window in which widening it is correct.
 *
 * `ownership/ownership-pass.ts` is the only current metadata writer on these types, so every
 * existing value belongs to it and migrates to `{"ownership": <existing>}`. Nothing is
 * discarded and no writer's history is guessed at.
 *
 * Three predicates carry weight and are easy to drop by accident:
 *
 * - `json(metadata)` rather than bare `metadata` — without it the existing object is stored
 *   as an ESCAPED STRING rather than nested JSON, and every read then returns null.
 * - `json_type(metadata) = 'object'` — excludes a valid JSON scalar or array, which
 *   `json_each` would otherwise iterate positionally and wrap into nonsense.
 * - The `NOT EXISTS` clause tests that NO top-level key is a known writer, not merely that
 *   `$.ownership` is absent. The narrower test would re-wrap a `{"symbols": …}` row. That
 *   cannot arise before this migration, but the check must not depend on that staying true.
 */
export const ENTITY_METADATA_V54_SQL = `
UPDATE graph_entity
SET metadata = json_object('ownership', json(metadata))
WHERE type IN ('source_file', 'directory', 'person', 'service', 'workspace', 'repo')
  AND metadata IS NOT NULL
  AND json_valid(metadata)
  AND json_type(metadata) = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(graph_entity.metadata)
    WHERE json_each.key IN ('ownership', 'symbols')
  );
`;
