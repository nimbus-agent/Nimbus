// packages/gateway/src/connectors/connector-writes/knowledge.ts
import { type ConnectorWriteRow, row, textField, withPreview } from "./types.ts";

export const KNOWLEDGE_ROWS: readonly ConnectorWriteRow[] = [
  row("notion_page_create", "notion.page.create", "mesh", 2),
  row("notion_page_update", "notion.page.update", "mesh", 2),
  row("notion_block_append", "notion.block.append", "mesh", 2),
  // The connector keeps only `text.slice(0, 2000)`; the label says so (the preview shows it all).
  withPreview(row("notion_comment_create", "notion.comment.create", "mesh", 2), {
    target: "{pageId}",
    summary: "Start a comment thread on Notion page {pageId}",
    fields: [textField("text", "Comment (Notion keeps only the first 2,000 characters)")],
  }),
  row("confluence_page_create", "confluence.page.create", "mesh", 2),
  row("confluence_page_update", "confluence.page.update", "mesh", 2),
  withPreview(row("confluence_comment_add", "confluence.comment.add", "mesh", 2), {
    target: "{pageId}",
    summary: "Add a footer comment to Confluence page {pageId}",
    fields: [textField("storageHtml", "Comment (Confluence storage HTML, sent as is)")],
  }),
  row("confluence_page_append", "confluence.page.append", "mesh", 2),
  row("obsidian_append_to_daily_note", "obsidian.note.append", "mesh", 2),
];
