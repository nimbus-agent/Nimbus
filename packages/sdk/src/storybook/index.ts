/**
 * Pure Storybook manifest parsing utilities — shared between the gateway
 * connector (storybook-story-mapping.ts) and the MCP connector
 * (storybook/src/storybook-parse.ts).
 *
 * PURE: no I/O, no env reads, no network. Filesystem reads stay in each caller.
 * Handles both the v7+ `{ entries: {…} }` shape and the legacy v6
 * `{ stories: {…} }` shape.
 */

/** A single Storybook story entry parsed from `index.json` / `stories.json`. */
export interface StorybookStory {
  readonly id: string;
  readonly title: string | null;
  readonly name: string | null;
  readonly importPath: string | null;
  readonly tags: readonly string[];
  readonly entryType: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function tagsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
}

function entryToStory(raw: unknown): StorybookStory | null {
  const r = asRecord(raw);
  if (r === null) {
    return null;
  }
  const id = str(r["id"]);
  if (id === null) {
    return null;
  }
  return {
    id,
    // v6 `stories.json` uses `kind` for the component title; v7 uses `title`.
    title: str(r["title"]) ?? str(r["kind"]),
    name: str(r["name"]) ?? str(r["story"]),
    importPath: str(r["importPath"]),
    tags: tagsOf(r["tags"]),
    entryType: str(r["type"]),
  };
}

/**
 * Pure parse of a Storybook manifest JSON object into stories. Handles the v7+
 * `{ entries: { <id>: {…} } }` shape and the legacy v6 `{ stories: { <id>:
 * {…} } }` shape. Returns [] for an unrecognised shape.
 */
export function parseStorybookIndex(parsed: unknown): StorybookStory[] {
  const root = asRecord(parsed);
  if (root === null) {
    return [];
  }
  const container = asRecord(root["entries"]) ?? asRecord(root["stories"]);
  if (container === null) {
    return [];
  }
  const out: StorybookStory[] = [];
  for (const value of Object.values(container)) {
    const story = entryToStory(value);
    if (story !== null) {
      out.push(story);
    }
  }
  return out;
}
