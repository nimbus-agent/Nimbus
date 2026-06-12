import { type KbCitation, markdownToNotionBlocks } from "../../shared/kb-markdown.ts";

export interface NotionKbAppendInput {
  databaseId: string;
  title: string;
  bodyMarkdown: string;
  citations: readonly KbCitation[];
  titlePropertyName?: string;
}

function richText(content: string): Record<string, unknown>[] {
  return [{ type: "text", text: { content: content.slice(0, 2000) } }];
}

/** Build the `POST /v1/pages` request body for a tribal-knowledge KB page in a database. */
export function buildNotionKbPageBody(input: NotionKbAppendInput): Record<string, unknown> {
  const prop = input.titlePropertyName ?? "Name";
  return {
    parent: { database_id: input.databaseId },
    properties: { [prop]: { title: richText(input.title) } },
    children: markdownToNotionBlocks(input.bodyMarkdown, input.citations),
  };
}
