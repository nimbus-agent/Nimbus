export const PERSON_HANDLES_V5_ALTER_SQL = `
ALTER TABLE person ADD COLUMN bitbucket_uuid TEXT;
ALTER TABLE person ADD COLUMN microsoft_user_id TEXT;
ALTER TABLE person ADD COLUMN discord_user_id TEXT;
`;
