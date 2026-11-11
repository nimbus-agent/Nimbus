import {
  collapseWhitespace,
  plainTextFromHtml,
  stripHtmlTagsToSpaces,
} from "../string/html-plain-text.ts";
import { namedTags } from "./_lib/field-helpers.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface ZoteroNoteMappingContext {
  readonly syncedAt: number;
}

/**
 * A Zotero note as an indexed item. Unlike the reference row (metadata only), a note IS prose, so
 * it declares a full `body`. `zotero:note` is registered in `LOCAL_ONLY_PROSE_TYPES`
 * (embedding/routing.ts): the long body cap applies, but the text is never sent to a remote
 * embedder, because a note is the user's own thinking and not public bibliographic metadata.
 */
export interface ZoteroNoteRow {
  readonly service: "zotero";
  readonly type: "note";
  readonly externalId: string;
  readonly title: string;
  readonly body: string;
  readonly url: null;
  readonly canonicalUrl: null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

const TITLE_MAX = 120;

/** Closing tags that end a visual line in a Zotero note, so the first line can be found. */
const BLOCK_END = /<\/(?:p|div|h[1-6]|li|blockquote|pre|tr)>|<br\s*\/?>/giu;

const ENTITIES: Readonly<Record<string, string>> = {
  "&nbsp;": " ",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&amp;": "&",
};

/** Decode the handful of entities Zotero's note editor emits. `&amp;` goes last so `&amp;lt;` stays `&lt;`. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:nbsp|lt|gt|quot|#39|apos|amp);/gu, (m) => ENTITIES[m] ?? m);
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

/** Plain text of a note's HTML body: tags removed first, entities decoded after, whitespace collapsed. */
export function noteBodyText(html: string): string {
  return collapseWhitespace(decodeEntities(plainTextFromHtml(html)));
}

/** First non-empty line of the note as plain text, truncated. `null` when the note has no text. */
export function noteTitle(html: string): string | null {
  for (const line of html.replace(BLOCK_END, "\n$&").split("\n")) {
    const text = collapseWhitespace(decodeEntities(stripHtmlTagsToSpaces(line)));
    if (text !== "") {
      return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
    }
  }
  return null;
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((c): c is string => typeof c === "string" && c !== "")
    : [];
}

export function mapZoteroNoteToItem(
  raw: unknown,
  ctx: ZoteroNoteMappingContext,
): ZoteroNoteRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const key = stringField(row, "key");
  if (key === undefined || key === "") {
    return null;
  }
  const data = asRecord(row["data"]);
  if (data === undefined || stringField(data, "itemType") !== "note") {
    return null;
  }

  const html = stringField(data, "note") ?? "";
  const parentKey = stringField(data, "parentItem");
  const dateModified = parseIsoMs(data["dateModified"]);
  const dateAdded = parseIsoMs(data["dateAdded"]);

  return {
    service: "zotero",
    type: "note",
    externalId: key,
    title: noteTitle(html) ?? `Note ${key}`,
    body: noteBodyText(html),
    url: null,
    canonicalUrl: null,
    modifiedAt: dateModified ?? dateAdded ?? ctx.syncedAt,
    metadata: {
      key,
      version: numberField(row, "version") ?? null,
      item_type: "note",
      // Set for a child note, `null` for a standalone note: the link a graph edge can follow later.
      parent_key: parentKey !== undefined && parentKey !== "" ? parentKey : null,
      tags: namedTags(data["tags"], "tag"),
      collections: stringList(data["collections"]),
      date_modified: dateModified,
      date_added: dateAdded,
    },
    syncedAt: ctx.syncedAt,
  };
}
