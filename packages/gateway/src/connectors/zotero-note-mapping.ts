import { collapseWhitespace } from "../string/html-plain-text.ts";
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

/**
 * Tags that start or end a block (or a table cell, or a line break). Only these become a space when
 * a note's tags are removed; every other tag (`<sub>`, `<sup>`, `<em>`, `<strong>`, a highlight
 * `<span>`) is dropped with no separator, so `H<sub>2</sub>O` stays `H2O`.
 */
const BLOCK_TAG_NAMES: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** A start or end tag. A quoted attribute value may hold a `>`, so the tag does not end there. */
const TAG = /<\/?([a-z][a-z0-9]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu;

/**
 * Remove a note's tags: a block tag becomes a space, an inline tag becomes nothing. Note-specific on
 * purpose; the shared `stripHtmlTagsToSpaces` turns every tag into a space and other connectors
 * depend on that.
 */
function stripNoteTags(html: string): string {
  return html.replace(TAG, (_tag, name: string) =>
    BLOCK_TAG_NAMES.has(name.toLowerCase()) ? " " : "",
  );
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
};

const ENTITY = /&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,6})|(nbsp|lt|gt|quot|apos|amp));/gu;

/** A code point that can stand for text: not NUL, not a surrogate, not past U+10FFFF. */
function isDecodableCodePoint(cp: number): boolean {
  return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
}

/**
 * Decode the named entities Zotero's note editor emits and decimal or hex character references, in
 * ONE pass, so `&amp;lt;` becomes `&lt;` and is not decoded again. A reference whose code point is
 * not decodable (`&#0;`, a surrogate, past U+10FFFF) is left as written.
 */
function decodeEntities(text: string): string {
  return text.replace(
    ENTITY,
    (m, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (named !== undefined) {
        return NAMED_ENTITIES[named] ?? m;
      }
      const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
      return isDecodableCodePoint(cp) ? String.fromCodePoint(cp) : m;
    },
  );
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

/** Plain text of a note's HTML body: tags removed first, entities decoded after, whitespace collapsed. */
export function noteBodyText(html: string): string {
  return collapseWhitespace(decodeEntities(stripNoteTags(html)));
}

/** `text` cut to `max` UTF-16 code units, without leaving half of a surrogate pair at the end. */
function truncateTitle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  // A code point above U+FFFF here means a pair starting at `max - 1`; a lone high surrogate reads as itself.
  const last = text.codePointAt(max - 1) ?? 0;
  const end = last > 0xffff || (last >= 0xd800 && last <= 0xdbff) ? max - 1 : max;
  return `${text.slice(0, end)}…`;
}

/** First non-empty line of the note as plain text, truncated. `null` when the note has no text. */
export function noteTitle(html: string): string | null {
  for (const line of html.split(BLOCK_END)) {
    const text = collapseWhitespace(decodeEntities(stripNoteTags(line)));
    if (text !== "") {
      return truncateTitle(text, TITLE_MAX);
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
