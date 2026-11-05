// packages/gateway/src/connectors/connector-writes/knowledge.ts
import {
  beforeReplyJson,
  codePointLength,
  excerptHead,
  excerptTail,
  presentFields,
  requiredStringAt,
  stringAt,
} from "./before-select.ts";
import {
  type BeforeStateField,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withPreview,
} from "./types.ts";

/** `v[key]` when it is an own property holding a plain (non-array) object. */
function ownRecord(v: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v) || !Object.hasOwn(v, key)) {
    return undefined;
  }
  const inner: unknown = (v as Record<string, unknown>)[key];
  return typeof inner === "object" && inner !== null && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : undefined;
}

/**
 * The page title from `notion_page_get` (`{ page, blockChildren }`): the joined `plain_text` of the
 * first `page.properties` entry whose `type` is `title`. Throws when there is none.
 */
function notionPageTitle(j: unknown): string {
  const props = ownRecord(ownRecord(j, "page"), "properties");
  for (const key of Object.keys(props ?? {})) {
    const prop = ownRecord(props, key);
    if (stringAt(prop, ["type"]) !== "title") continue;
    const parts: unknown =
      prop !== undefined && Object.hasOwn(prop, "title") ? prop["title"] : undefined;
    if (!Array.isArray(parts)) break;
    const title = parts.map((p: unknown) => stringAt(p, ["plain_text"]) ?? "").join("");
    // An empty title names nothing: the prompt reads `unavailable (failed)`, not `Title: ""`.
    if (title !== "") return title;
    break;
  }
  throw new Error("before reply: no Notion page title");
}

/**
 * Notion `notion_page_get` (before-state, spec 5.4), for a comment: the page title, never its
 * blocks (the B3 page selectors below show a capped excerpt; the comment readers show none).
 */
export function selectNotionPageIdentity(reply: unknown): readonly BeforeStateField[] {
  return [{ label: "Title", value: notionPageTitle(beforeReplyJson(reply)) }];
}

/**
 * Confluence `confluence_page_get` (before-state), for a comment: title, space, version; never
 * `body.storage` (the B3 update and append selectors below show a capped excerpt of it).
 */
export function selectConfluencePageIdentity(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  return [
    { label: "Title", value: requiredStringAt(j, ["title"]) },
    ...presentFields([
      ["Space", stringAt(j, ["space", "key"])],
      ["Version", stringAt(j, ["version", "number"])],
    ]),
  ];
}

// ---------------------------------------------------------------------------------------------
// B3 page selectors (plan R3/R4; owner brief: a page update or append may show a BOUNDED excerpt
// of the current content). Every value goes through `excerptHead` or `excerptTail`, so each is at
// most BEFORE_EXCERPT_MAX_CHARS (1,000) code points plus a fixed marker, titles and names
// included; a Notion before shows at most NOTION_BEFORE_BLOCKS_MAX blocks, and every selector
// returns well under BEFORE_STATE_MAX_FIELDS fields by construction. The runner sanitises every
// value (`sanitisePreviewText`) and caps the reply at 4 MiB (`beforeReplyJson`). A selector that
// needs the write's input reads it FIRST, so the selection probe sees every key it reads.
// ---------------------------------------------------------------------------------------------

/** A Notion before shows at most this many of the page's first blocks. */
export const NOTION_BEFORE_BLOCKS_MAX = 5;

/** A Notion update's before shows the current value of at most this many named properties. */
export const NOTION_BEFORE_PROPERTIES_MAX = 10;

/** One Notion block line is at most this many code points (plus the marker). */
const NOTION_BLOCK_LINE_MAX = 200;

/** A property name in a label is at most this many code points (plus the marker). */
const NOTION_PROPERTY_NAME_MAX = 100;

/**
 * The block types whose `rich_text` the excerpt reads (review fix 3). Any other block (a divider,
 * an image, an embed, a child page) shows its type only; its content is never read.
 */
const NOTION_TEXT_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "quote",
  "callout",
  "toggle",
]);

/** Notion `notion_page_get`, for a page created under it: the parent page's title. */
export function selectNotionParent(reply: unknown): readonly BeforeStateField[] {
  return [{ label: "Parent title", value: excerptHead(notionPageTitle(beforeReplyJson(reply))) }];
}

/** `{ type, text }` of one block: `text` is the joined `rich_text` of a known text block, else "". */
function notionBlockLine(block: unknown): { readonly type: string; readonly text: string } {
  const type = stringAt(block, ["type"]) ?? "(unknown block)";
  if (!NOTION_TEXT_BLOCK_TYPES.has(type)) return { type, text: "" };
  const body = ownRecord(block, type);
  const rich: unknown =
    body !== undefined && Object.hasOwn(body, "rich_text") ? body["rich_text"] : [];
  const text = Array.isArray(rich)
    ? (rich as unknown[]).map((r) => stringAt(r, ["plain_text"]) ?? "").join("")
    : "";
  return { type, text };
}

/**
 * Notion `notion_page_get`, for a block append: the title, then the page's first
 * {@link NOTION_BEFORE_BLOCKS_MAX} blocks (`Block N: <type>: <text>`, or `<type>` for a block with
 * no text, each capped at 200 code points). `Blocks: (no text)` when none of them is a text block
 * with text (an empty page too); `More blocks` when the page has more (`has_more`, or more than
 * five came back). The append goes after the LAST block, which is not shown when there are more.
 * A `blockChildren.results` that is not an array throws (`unavailable (failed)`).
 */
export function selectNotionFirstBlocks(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const title = notionPageTitle(j);
  const children = ownRecord(j, "blockChildren");
  const results: unknown =
    children !== undefined && Object.hasOwn(children, "results") ? children["results"] : undefined;
  if (!Array.isArray(results)) throw new Error("before reply: no Notion block list");
  const blocks = results as unknown[];
  const out: BeforeStateField[] = [{ label: "Title", value: excerptHead(title) }];
  let anyText = false;
  for (const [i, block] of blocks.slice(0, NOTION_BEFORE_BLOCKS_MAX).entries()) {
    const line = notionBlockLine(block);
    if (line.text !== "") anyText = true;
    const value = line.text === "" ? line.type : `${line.type}: ${line.text}`;
    out.push({ label: `Block ${String(i + 1)}`, value: excerptHead(value, NOTION_BLOCK_LINE_MAX) });
  }
  if (!anyText) out.push({ label: "Blocks", value: "(no text)" });
  if (children?.["has_more"] === true || blocks.length > NOTION_BEFORE_BLOCKS_MAX) {
    out.push({
      label: "More blocks",
      value: "yes, not shown (the append goes after the last block)",
    });
  }
  return out;
}

/** The own keys of `propertiesJson` when it parses to a plain object, else `undefined`. */
function namedProperties(raw: unknown): string[] | undefined {
  if (typeof raw !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return Object.keys(parsed);
}

/** The compact JSON of a Notion property value without its `id` key. */
function notionPropertyJson(prop: Record<string, unknown>): string {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(prop)) {
    if (k !== "id") copy[k] = v;
  }
  return JSON.stringify(copy);
}

/**
 * Notion `notion_page_get`, for a property update: the title, then for each property the write
 * names (the own keys of `propertiesJson`, in its order, at most
 * {@link NOTION_BEFORE_PROPERTIES_MAX}) its current value as compact JSON without `id`, or
 * `(not on the page)`; more names give one `Other properties named` count. A `propertiesJson`
 * that is not a JSON object gives the title alone (the write fails upstream).
 */
export function selectNotionNamedProperties(
  reply: unknown,
  picked: Readonly<Record<string, unknown>>,
): readonly BeforeStateField[] {
  const names = namedProperties(picked["propertiesJson"]);
  const j = beforeReplyJson(reply);
  const out: BeforeStateField[] = [{ label: "Title", value: excerptHead(notionPageTitle(j)) }];
  if (names === undefined) return out;
  const props = ownRecord(ownRecord(j, "page"), "properties");
  for (const name of names.slice(0, NOTION_BEFORE_PROPERTIES_MAX)) {
    const prop = ownRecord(props, name);
    out.push({
      label: `Current ${excerptHead(name, NOTION_PROPERTY_NAME_MAX)}`,
      value: prop === undefined ? "(not on the page)" : excerptHead(notionPropertyJson(prop)),
    });
  }
  const more = names.length - NOTION_BEFORE_PROPERTIES_MAX;
  if (more > 0) {
    out.push({ label: "Other properties named", value: `${String(more)} more not shown` });
  }
  return out;
}

/** Title, space and version of a Confluence page (each capped), the title required. */
function confluenceIdentity(j: unknown): BeforeStateField[] {
  return [
    { label: "Title", value: excerptHead(requiredStringAt(j, ["title"])) },
    ...presentFields([
      ["Space", stringAt(j, ["space", "key"])],
      ["Version", stringAt(j, ["version", "number"])],
    ]).map((f) => ({ label: f.label, value: excerptHead(f.value) })),
  ];
}

/** The page's `body.storage.value`, "" when absent. */
function confluenceBody(j: unknown): string {
  return stringAt(j, ["body", "storage", "value"]) ?? "";
}

/**
 * Confluence `confluence_page_get`, for an update (which replaces the title and the WHOLE body):
 * title, space, version; whether the write's `versionNumber` matches the current version (the
 * schema takes an integer; this compares `String(...)`); the current length; and the start of the
 * current body (`excerptHead`), or `(empty)`.
 */
export function selectConfluenceReplaceHead(
  reply: unknown,
  picked: Readonly<Record<string, unknown>>,
): readonly BeforeStateField[] {
  const expected = String(picked["versionNumber"]);
  const j = beforeReplyJson(reply);
  const out = confluenceIdentity(j);
  const current = stringAt(j, ["version", "number"]);
  if (current !== undefined) {
    out.push({
      label: "Version check",
      value:
        expected === current
          ? `matches; the write saves version ${String(Number(current) + 1)}`
          : excerptHead(
              `does not match the current version ${current}: Confluence will refuse the write`,
            ),
    });
  }
  const body = confluenceBody(j);
  out.push(
    {
      label: "Current length",
      value: `${String(codePointLength(body))} characters (all replaced)`,
    },
    { label: "Current body (start)", value: body === "" ? "(empty)" : excerptHead(body) },
  );
  return out;
}

/**
 * Confluence `confluence_page_get`, for an append (one read, the owner brief; the connector's own
 * GET and PUT run after approval): title, space, version, the current length, and the END of the
 * current body (`excerptTail`, where the append lands), or `(empty)`.
 */
export function selectConfluenceAppendTail(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const body = confluenceBody(j);
  return [
    ...confluenceIdentity(j),
    { label: "Current length", value: `${String(codePointLength(body))} characters (kept)` },
    { label: "Current body (end)", value: body === "" ? "(empty)" : excerptTail(body) },
  ];
}

export const KNOWLEDGE_ROWS: readonly ConnectorWriteRow[] = [
  // The connector sends the title only (no body), under `titlePropertyName` (default "title").
  // The before names the parent page (its title).
  withBefore(
    withPreview(row("notion_page_create", "notion.page.create", "mesh", 2), {
      target: "{parentPageId}",
      summary: "Create a Notion page under page {parentPageId}",
      fields: [
        textField("title", "Title"),
        textField("titlePropertyName", "Title property", "title"),
      ],
    }),
    {
      tool: "notion_page_get",
      argKeys: ["parentPageId"],
      args: (input) => ({ pageId: input["parentPageId"] }),
      select: selectNotionParent,
    },
  ),
  // PATCH replaces each named property; the JSON is sent as is (shown as text, never rendered).
  // The before shows the current value of each property the write names (capped).
  withBefore(
    withPreview(row("notion_page_update", "notion.page.update", "mesh", 2), {
      target: "{pageId}",
      summary: "Update properties of Notion page {pageId}",
      fields: [
        textField(
          "propertiesJson",
          "Properties to set (Notion property JSON, sent as is; each named property is replaced)",
        ),
      ],
    }),
    {
      tool: "notion_page_get",
      // `propertiesJson` is read by the selection (which properties), never sent to the read.
      argKeys: ["pageId", "propertiesJson"],
      args: (input) => ({ pageId: input["pageId"] }),
      select: selectNotionNamedProperties,
    },
  ),
  // The blocks are appended after the last child; the JSON is sent as is.
  // The before shows the page's first blocks (at most five, capped). A `parentBlockId` that is a
  // block, not a page, makes the page GET fail: `unavailable (failed)` (stated bound).
  withBefore(
    withPreview(row("notion_block_append", "notion.block.append", "mesh", 2), {
      target: "{parentBlockId}",
      summary: "Append blocks to the end of Notion page or block {parentBlockId}",
      fields: [textField("childrenJson", "Blocks to append (Notion block JSON, sent as is)")],
    }),
    {
      tool: "notion_page_get",
      argKeys: ["parentBlockId"],
      args: (input) => ({ pageId: input["parentBlockId"] }),
      select: selectNotionFirstBlocks,
    },
  ),
  // The connector keeps only `text.slice(0, 2000)`; the label says so (the preview shows it all).
  withBefore(
    withPreview(row("notion_comment_create", "notion.comment.create", "mesh", 2), {
      target: "{pageId}",
      summary: "Start a comment thread on Notion page {pageId}",
      fields: [textField("text", "Comment (Notion keeps only the first 2,000 characters)")],
    }),
    {
      tool: "notion_page_get",
      argKeys: ["pageId"],
      args: (input) => ({ pageId: input["pageId"] }),
      select: selectNotionPageIdentity,
    },
  ),
  // `ancestors` is sent only when a parent is given.
  withPreview(row("confluence_page_create", "confluence.page.create", "mesh", 2), {
    target: "{spaceKey}",
    summary: "Create a Confluence page in space {spaceKey}",
    fields: [
      textField("title", "Title"),
      textField("parentPageId", "Parent page", "(not set: no parent page is sent)"),
      textField("storageHtml", "Body (Confluence storage HTML, sent as is)"),
    ],
  }),
  // A PUT at version `versionNumber + 1`: replaces the title and the WHOLE body.
  // The before shows the version check, the current length and the start of the current body.
  withBefore(
    withPreview(row("confluence_page_update", "confluence.page.update", "mesh", 2), {
      target: "{pageId}",
      summary: "Replace the title and the whole body of Confluence page {pageId}",
      fields: [
        textField("versionNumber", "Expected current version (the write saves the next one)"),
        textField("title", "New title"),
        textField(
          "storageHtml",
          "New body (Confluence storage HTML, sent as is; replaces everything on the page)",
        ),
      ],
    }),
    {
      tool: "confluence_page_get",
      // `versionNumber` is read by the selection (the version check), never sent to the read.
      argKeys: ["pageId", "versionNumber"],
      args: (input) => ({ pageId: input["pageId"] }),
      select: selectConfluenceReplaceHead,
    },
  ),
  withBefore(
    withPreview(row("confluence_comment_add", "confluence.comment.add", "mesh", 2), {
      target: "{pageId}",
      summary: "Add a footer comment to Confluence page {pageId}",
      fields: [textField("storageHtml", "Comment (Confluence storage HTML, sent as is)")],
    }),
    {
      tool: "confluence_page_get",
      argKeys: ["pageId"],
      args: (input) => ({ pageId: input["pageId"] }),
      select: selectConfluencePageIdentity,
    },
  ),
  // The connector GETs the page and PUTs the old body plus the new (re-reading once on a 409).
  // One read (the owner brief): the before shows the end of the current body, where it lands.
  withBefore(
    withPreview(row("confluence_page_append", "confluence.page.append", "mesh", 2), {
      target: "{pageId}",
      summary: "Append to the end of Confluence page {pageId}, keeping everything already on it",
      fields: [textField("storageHtml", "Appended content (Confluence storage HTML, sent as is)")],
    }),
    {
      tool: "confluence_page_get",
      argKeys: ["pageId"],
      args: (input) => ({ pageId: input["pageId"] }),
      select: selectConfluenceAppendTail,
    },
  ),
  row("obsidian_append_to_daily_note", "obsidian.note.append", "mesh", 2),
];
