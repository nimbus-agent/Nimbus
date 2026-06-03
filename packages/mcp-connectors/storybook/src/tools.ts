import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import type { ZodToolRegistrar } from "../../shared/run-read-only-mcp-connector.ts";
import { filterStories, loadStories, type StorybookStory } from "./storybook-parse.ts";

/**
 * Storybook MCP tool surface. Reads the local Storybook manifest (index.json /
 * stories.json) and returns story-level metadata — a pure filesystem read. No
 * browser, no dev-server connection, no code execution.
 */
export const STORYBOOK_TOOL_NAMES = [
  "storybook_list",
  "storybook_get",
  "storybook_search",
] as const;

function toEnvelope(s: StorybookStory): Record<string, unknown> {
  return {
    id: s.id,
    title: s.title,
    name: s.name,
    importPath: s.importPath,
    tags: [...s.tags],
    type: s.entryType,
  };
}

/**
 * Register the read-only Storybook tools onto the given registrar. Shared
 * between `server.ts` (live) and the contract test (introspection).
 */
export function registerStorybookTools(reg: ZodToolRegistrar): void {
  reg(
    "storybook_list",
    "List stories from the local Storybook manifest (index.json / stories.json). Returns each story's id, component title, story name, import path, tags, and type. A pure filesystem read — no browser or dev server is contacted.",
    z.object({ limit: z.number().int().min(1).max(2000).optional() }),
    async (p) => {
      const all = await loadStories();
      const limit = p.limit ?? 500;
      return jsonResult({ items: all.slice(0, limit).map(toEnvelope) });
    },
  );

  reg(
    "storybook_get",
    "Fetch one story by its Storybook id (e.g. 'components-button--primary'). Returns the story's metadata, or null if absent.",
    z.object({ id: z.string().min(1).max(512) }),
    async (p) => {
      const all = await loadStories();
      const found = all.find((s) => s.id === p.id) ?? null;
      return jsonResult(found === null ? { item: null } : { item: toEnvelope(found) });
    },
  );

  reg(
    "storybook_search",
    "Substring search over stories (matches id, component title, story name, and tags). Returns the same view as storybook_list.",
    z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(2000).optional(),
    }),
    async (p) => {
      const all = await loadStories();
      const matches = filterStories(all, p.query).slice(0, p.limit ?? 500);
      return jsonResult({ matches: matches.map(toEnvelope) });
    },
  );
}
