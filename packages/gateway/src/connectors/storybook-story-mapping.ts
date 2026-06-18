import { parseStorybookIndex, type StorybookStory } from "@nimbus-dev/sdk";
import type { MappedRow } from "./mapped-row.ts";

/**
 * Gateway-side Storybook story mapping. Pure parsing of the manifest is shared
 * via `@nimbus-dev/sdk` (`parseStorybookIndex` / `StorybookStory`); this module
 * owns only the gateway-specific mapper that converts a story to an IndexedItem.
 */

/** @deprecated Use `StorybookStory` from `@nimbus-dev/sdk` instead. */
export type StorybookStoryInput = StorybookStory;

export { parseStorybookIndex };

export interface StorybookMappingContext {
  readonly syncedAt: number;
  readonly modifiedAtMs: number | null;
}

export type StorybookMappedRow = MappedRow<"storybook", "story">;

const TITLE_MAX = 256;
const PREVIEW_MAX = 1000;
const SERVICE = "storybook" as const;
const TYPE = "story" as const;

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Pure mapper: a parsed Storybook story entry → a `storybook:story` IndexedItem.
 * Stores story-level METADATA only (component title, story name, import path,
 * tags, type). Returns null when the entry has no id.
 */
export function mapStorybookStoryToItem(
  input: StorybookStoryInput,
  ctx: StorybookMappingContext,
): StorybookMappedRow | null {
  const id = input.id.trim();
  if (id === "") {
    return null;
  }

  const titlePart = input.title ?? "";
  const namePart = input.name ?? "";
  const singlePart = titlePart === "" ? namePart : titlePart;
  const eitherOrId = singlePart === "" ? id : singlePart;
  const display = titlePart !== "" && namePart !== "" ? `${titlePart} / ${namePart}` : eitherOrId;
  const title = clamp(display, TITLE_MAX);

  const previewParts = [display, input.importPath ?? "", input.tags.join(" ")].filter(
    (p) => p !== "",
  );
  const bodyPreview = clamp(previewParts.join(" — "), PREVIEW_MAX);

  const metadata: Record<string, unknown> = {
    storyId: id,
    componentTitle: input.title,
    name: input.name,
    importPath: input.importPath,
    tags: [...input.tags],
    entryType: input.entryType,
  };

  return {
    service: SERVICE,
    type: TYPE,
    externalId: id,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt: ctx.modifiedAtMs ?? ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
