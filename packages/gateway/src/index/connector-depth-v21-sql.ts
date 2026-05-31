export const CONNECTOR_DEPTH_V21_SQL = `
ALTER TABLE sync_state ADD COLUMN depth TEXT NOT NULL DEFAULT 'summary'
  CHECK(depth IN ('metadata_only','summary','full'));
`;
