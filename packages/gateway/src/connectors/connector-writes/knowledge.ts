// packages/gateway/src/connectors/connector-writes/knowledge.ts
import { type ConnectorWriteRow, row } from "./types.ts";

export const KNOWLEDGE_ROWS: readonly ConnectorWriteRow[] = [
  row("notion_page_create", "notion.page.create", "mesh", 2),
  row("notion_page_update", "notion.page.update", "mesh", 2),
  row("notion_block_append", "notion.block.append", "mesh", 2),
  row("notion_comment_create", "notion.comment.create", "mesh", 2),
  row("confluence_page_create", "confluence.page.create", "mesh", 2),
  row("confluence_page_update", "confluence.page.update", "mesh", 2),
  row("confluence_comment_add", "confluence.comment.add", "mesh", 2),
  row("confluence_page_append", "confluence.page.append", "mesh", 2),
  row("obsidian_append_to_daily_note", "obsidian.note.append", "mesh", 2),
];
