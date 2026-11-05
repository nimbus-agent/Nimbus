// packages/gateway/src/connectors/connector-writes/knowledge.ts
import { beforeReplyJson, presentFields, requiredStringAt, stringAt } from "./before-select.ts";
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
    return parts.map((p: unknown) => stringAt(p, ["plain_text"]) ?? "").join("");
  }
  throw new Error("before reply: no Notion page title");
}

/** Notion `notion_page_get` (before-state, spec 5.4): the page title, never its blocks. */
export function selectNotionPageIdentity(reply: unknown): readonly BeforeStateField[] {
  return [{ label: "Title", value: notionPageTitle(beforeReplyJson(reply)) }];
}

/** Confluence `confluence_page_get` (before-state): title, space, version; never `body.storage`. */
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

export const KNOWLEDGE_ROWS: readonly ConnectorWriteRow[] = [
  row("notion_page_create", "notion.page.create", "mesh", 2),
  row("notion_page_update", "notion.page.update", "mesh", 2),
  row("notion_block_append", "notion.block.append", "mesh", 2),
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
  row("confluence_page_create", "confluence.page.create", "mesh", 2),
  row("confluence_page_update", "confluence.page.update", "mesh", 2),
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
  row("confluence_page_append", "confluence.page.append", "mesh", 2),
  row("obsidian_append_to_daily_note", "obsidian.note.append", "mesh", 2),
];
