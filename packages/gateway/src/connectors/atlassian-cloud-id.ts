// packages/gateway/src/connectors/atlassian-cloud-id.ts

/** The length of an Atlassian cloud id (a UUID: 32 hex digits and four hyphens). */
const CLOUD_ID_CHARS = 36;

/**
 * An Atlassian cloud id: the same rule as the Jira connector's `CLOUD_ID_PATTERN`
 * (`/^[0-9a-f-]{36}$/i`, `connectors/jira/src/tools.ts`), which a source-reading test pins. The
 * Jira Service Management Operations tools build `https://api.atlassian.com/jsm/ops/api/{cloudId}/v1`
 * from it, so a malformed value is refused before it is stored or handed to the child.
 *
 * Length first, then one linear pass over at most 36 characters: no regular expression, so an
 * oversized value from an IPC call or the Vault costs one comparison. No trimming here: the
 * caller trims.
 */
export function isAtlassianCloudId(value: string): boolean {
  if (value.length !== CLOUD_ID_CHARS) return false;
  for (let i = 0; i < CLOUD_ID_CHARS; i++) {
    const c = value.charCodeAt(i);
    const digit = c >= 0x30 && c <= 0x39;
    const lower = c >= 0x61 && c <= 0x66;
    const upper = c >= 0x41 && c <= 0x46;
    if (!(digit || lower || upper || c === 0x2d)) return false;
  }
  return true;
}
