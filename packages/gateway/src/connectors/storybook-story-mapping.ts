import type { MappedRow } from "./mapped-row.ts";

/**
 * One story entry parsed from a local Storybook manifest (`index.json` v7+ or
 * the legacy `stories.json` v6). The gateway cannot import the connector
 * package, so this mirrors the parsed shape.
 *
 * Local-only, no-network: the Storybook component/story manifest is a JSON file
 * the user's `storybook build` (or dev server) writes to disk. No browser, no
 * dev server connection, no code execution.
 */
export interface StorybookStoryInput {
  /** Stable story id (e.g. `button--primary`). */
  readonly id: string;
  /** Component title / kind (e.g. `Components/Button`). */
  readonly title: string | null;
  /** Story name (e.g. `Primary`). */
  readonly name: string | null;
  readonly importPath: string | null;
  readonly tags: readonly string[];
  /** `"story"` | `"docs"` (v7) — null for legacy manifests. */
  readonly entryType: string | null;
}

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

function entryToInput(raw: unknown): StorybookStoryInput | null {
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
 * Pure parse of a Storybook manifest JSON object into story inputs. Handles the
 * v7+ `{ entries: { <id>: {…} } }` shape and the legacy v6 `{ stories: { <id>:
 * {…} } }` shape. Returns [] for an unrecognized shape.
 */
export function parseStorybookIndex(parsed: unknown): StorybookStoryInput[] {
  const root = asRecord(parsed);
  if (root === null) {
    return [];
  }
  const container = asRecord(root["entries"]) ?? asRecord(root["stories"]);
  if (container === null) {
    return [];
  }
  const out: StorybookStoryInput[] = [];
  for (const value of Object.values(container)) {
    const input = entryToInput(value);
    if (input !== null) {
      out.push(input);
    }
  }
  return out;
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
