/**
 * The write rows the post-mortem push (Phase 10 IC7a) runs, named in ONE place inside the row table's own
 * directory (static D20 confines every write tool id to it). `postmortem/postmortem-push.ts` imports these
 * ids and looks each row up in the table; it adds no row and does not name a tool itself. The Notion create
 * sends a title only, so its body is the Notion block append row.
 */
export const PAGE_PUSH_TOOL_IDS = Object.freeze({
  confluenceCreate: "confluence_page_create",
  notionCreate: "notion_page_create",
  notionAppend: "notion_block_append",
} as const);
