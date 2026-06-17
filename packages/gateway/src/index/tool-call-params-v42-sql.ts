// V42 — tool_call_log.params_json (Phase 6 Slice 8b: Recipe).
// Stores the SECRET-redacted JSON of each tool call's input params so a session can be
// reconstructed as a declarative recipe DAG (share/recipe.ts) with real per-step params.
// Nullable + no backfill: rows logged before V42 read back NULL (params unknown). Secrets are
// stripped at write time via redactAuditPayload; the share-gate applies the full PII set on top.
export const TOOL_CALL_PARAMS_V42_SQL = `
ALTER TABLE tool_call_log ADD COLUMN params_json TEXT;
`;
