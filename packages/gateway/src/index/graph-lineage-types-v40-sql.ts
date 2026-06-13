// V40 — seed the data-warehouse/BI lineage relation types (Phase 6 Slice 7).
// graph_relation.type is FK-constrained to graph_relation_type(name), so these
// must exist before any lineage edge can be inserted. `upstream_refs` aligns
// with the path vocabulary agents/impact.ts already uses.
export const GRAPH_LINEAGE_TYPES_V40_SQL = `
INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES
  ('upstream_refs', 1),
  ('derived_from', 1),
  ('monitors', 1);
`;
