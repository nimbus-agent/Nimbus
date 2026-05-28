export const WORKFLOW_RUN_COLUMNS_V23_SQL = `
ALTER TABLE workflow_run ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_run ADD COLUMN params_override_json TEXT;
`;
