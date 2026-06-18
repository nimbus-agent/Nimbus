import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseStorybookIndex, type StorybookStory } from "@nimbus-dev/sdk";

export type { StorybookStory };
export { parseStorybookIndex };

/**
 * Local-only reader for a Storybook component/story manifest. This module is the
 * MCP-server-side counterpart of the gateway's `mapStorybookStoryToItem` mapper:
 * it reads the `index.json` (v7+) or legacy `stories.json` (v6) manifest that
 * `storybook build` writes to disk and returns story-level METADATA.
 *
 * No browser, no dev-server connection, no code execution — a pure filesystem
 * read of one JSON manifest under the configured Storybook output dir.
 */

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MANIFEST_NAMES = ["index.json", "stories.json"] as const;

/**
 * Resolve the configured Storybook dir from the environment. Throws when unset so
 * the MCP tools surface a clear error rather than reading an empty path.
 */
export function storybookDir(): string {
  const dir = process.env["STORYBOOK_DIR"]?.trim();
  if (dir === undefined || dir === "") {
    throw new Error("STORYBOOK_DIR is not set");
  }
  return resolve(dir);
}

async function readManifest(root: string): Promise<unknown> {
  for (const name of MANIFEST_NAMES) {
    try {
      const buf = await readFile(join(root, name));
      if (buf.byteLength > MAX_FILE_BYTES) {
        return null;
      }
      return JSON.parse(buf.toString("utf8")) as unknown;
    } catch {
      // try the next candidate name
    }
  }
  return null;
}

/** Read + parse all stories from the manifest under the configured dir. */
export async function loadStories(): Promise<StorybookStory[]> {
  const parsed = await readManifest(storybookDir());
  return parsed === null ? [] : parseStorybookIndex(parsed);
}

/** Substring search over story id / component title / story name / tags. */
export function filterStories(stories: readonly StorybookStory[], query: string): StorybookStory[] {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return [...stories];
  }
  return stories.filter(
    (s) =>
      s.id.toLowerCase().includes(q) ||
      (s.title ?? "").toLowerCase().includes(q) ||
      (s.name ?? "").toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q)),
  );
}
