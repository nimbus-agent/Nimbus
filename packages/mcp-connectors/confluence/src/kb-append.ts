import { type KbCitation, markdownToConfluenceStorage } from "../../shared/kb-markdown.ts";

export interface ConfluenceKbAppendInput {
  spaceKey: string;
  parentPageId: string;
  title: string;
  bodyMarkdown: string;
  citations: readonly KbCitation[];
}

/** Build the `POST /content` request body for a tribal-knowledge KB page under a parent. */
export function buildConfluenceKbPageBody(input: ConfluenceKbAppendInput): Record<string, unknown> {
  return {
    type: "page",
    title: input.title,
    space: { key: input.spaceKey },
    ancestors: [{ id: input.parentPageId }],
    body: {
      storage: {
        value: markdownToConfluenceStorage(input.bodyMarkdown, input.citations),
        representation: "storage",
      },
    },
  };
}
