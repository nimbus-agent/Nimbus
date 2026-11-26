// packages/gateway/src/connectors/connector-writes/null-optional-refusals.ts
// Null optional fields on the B4a rows (coordinator rulings 2026-11-05): an optional input key
// that is present but `null` is refused on both doors. The preview renders `null` as the field's
// unset default (`UTC`, `(not set: no one is invited)`, `(not set: the root of My Drive)`, ...)
// while the connector's schema rejects `null`, so the preview would claim what will not happen.
// The keys are the optional (`whenUnset`) schema keys of each row; the text names the key (from
// this table, never from the input) and echoes no value. `messagingDestinationRefusal`
// (`model-write-refusals.ts`, which re-exports the two public functions) runs it before the
// calendar checks, so a null iCloud field reports this text rather than the iCloud text refusal.
// Moved out of `model-write-refusals.ts` unchanged, since that file's size is locked.

/** The fixed refusal for a present-but-null optional field `key` (a schema key, never a value). */
export function nullOptionalFieldRefusal(key: string): string {
  return `the field \`${key}\` cannot be null; omit it or give a value`;
}

/** The optional input keys of each B4a row, the Flagsmith state set (C3), three D3b rows and the Bitbucket comment, whose `null` the doors refuse. */
const NULL_REFUSED_OPTIONAL_KEYS: Readonly<Record<string, readonly string[]>> = {
  outlook_calendar_create: ["timeZone", "attendees", "body"],
  apple_calendar_event_create: ["calendar", "attendees", "location", "description", "uid"],
  gdrive_file_create: ["mimeType", "parentId", "content"],
  flagsmith_feature_state_set: ["value"],
  // D3b: the optional keys of the deploy and mobile-release rows.
  vercel_deployment_redeploy: ["withLatestCommit"],
  netlify_build_trigger: ["branch", "production", "clearCache"],
  firebase_app_distribution_distribute: ["groupAliases", "testerEmails"],
  // Connectors PR 106: a null file or line would render "(not set: ...)" yet fail the schema.
  bitbucket_pr_comment_create: ["path", "line"],
};

/** The optional keys whose `null` is refused for `toolId` (read-only, for its drift test). */
export function nullRefusedOptionalKeys(toolId: string): readonly string[] {
  return Object.hasOwn(NULL_REFUSED_OPTIONAL_KEYS, toolId)
    ? (NULL_REFUSED_OPTIONAL_KEYS[toolId] ?? [])
    : [];
}

/** The null-field check (`undefined` for every other row, or when no listed key is null). */
export function nullOptionalFieldCheck(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const key = nullRefusedOptionalKeys(toolId).find(
    (k) => Object.hasOwn(input, k) && input[k] === null,
  );
  return key === undefined ? undefined : nullOptionalFieldRefusal(key);
}
