// packages/gateway/src/connectors/connector-writes/nested-text-refusals.ts
// Free text one level down: a row whose input carries a LIST of objects, each with its own text
// field (`@nimbus-dev/connectors` 0.19.0: `github_pr_review_create` `comments[].body`, the inline
// review comments). `model-write-refusals.ts` scans each such text with the same detector as the
// row's top-level text (broadcast mentions, remote content), so an inline comment is held to the
// rule its review body is. Kept out of that file, whose size is locked by `audit:file-size`.

/** One nested text field: the list key, and the text key of each entry. */
interface NestedTextKey {
  readonly list: string;
  readonly key: string;
}

/** The rows with nested text, and where it sits. */
const NESTED_TEXT_ROWS: Readonly<Record<string, NestedTextKey>> = {
  github_pr_review_create: { list: "comments", key: "body" },
};

/** `list[].key` for each nested text field of `toolId` (read-only, for the tripwires). */
export function nestedTextKeys(toolId: string): readonly string[] {
  if (!Object.hasOwn(NESTED_TEXT_ROWS, toolId)) return [];
  const spec = NESTED_TEXT_ROWS[toolId];
  return spec === undefined ? [] : [`${spec.list}[].${spec.key}`];
}

/**
 * Whether a nested text of `toolId` must be refused: a text `refuses` matches, or a shape the scan
 * cannot read (a present list that is not an array, an entry that is not an object, an entry whose
 * text is missing or not a string). An absent, `undefined` or `null` list is skipped (the list is
 * optional; a `null` one is refused by the null-optional check). `false` for every other row.
 */
export function nestedTextRefuses(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
  refuses: (text: string) => boolean,
): boolean {
  if (!Object.hasOwn(NESTED_TEXT_ROWS, toolId)) return false;
  const spec = NESTED_TEXT_ROWS[toolId];
  if (spec === undefined) return false;
  const list = Object.hasOwn(input, spec.list) ? input[spec.list] : undefined;
  if (list === undefined || list === null) return false;
  if (!Array.isArray(list)) return true;
  return (list as unknown[]).some((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return true;
    const text = Object.hasOwn(entry, spec.key)
      ? (entry as Record<string, unknown>)[spec.key]
      : undefined;
    return typeof text === "string" ? refuses(text) : true;
  });
}
