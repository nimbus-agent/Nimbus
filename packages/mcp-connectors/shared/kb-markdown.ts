/**
 * Minimal, robust converter from the SIMPLE markdown the tribal answer-synthesizer emits
 * (plain paragraphs + `-` bulleted lists; no headers/tables/code/HTML) into Notion blocks and
 * Confluence storage HTML, plus a Sources section built from citations. The body parser is a
 * line-walker that NEVER throws on unexpected markup: any non-empty, non-bullet line becomes a
 * paragraph (so a stray `#` or ``` line degrades to literal paragraph text, not an error).
 */

export interface KbCitation {
  itemId: string;
  channelId: string;
  url: string | null;
}

export type KbLine = { kind: "bullet" | "paragraph"; text: string };

/** Classify each non-blank line as a bullet (`- ` prefix) or a paragraph (everything else). */
export function parseSimpleMarkdown(md: string): KbLine[] {
  const out: KbLine[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      out.push({ kind: "bullet", text: bullet[1] ?? "" });
    } else {
      out.push({ kind: "paragraph", text: line });
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function citationLabel(c: KbCitation): string {
  return `${c.channelId} · ${c.itemId}`;
}

function notionRichText(content: string, url?: string | null): Record<string, unknown>[] {
  const text: Record<string, unknown> = { content: content.slice(0, 2000) };
  if (url !== undefined && url !== null && url !== "") text["link"] = { url };
  return [{ type: "text", text }];
}

/** Body → Notion blocks, then a "Sources:" paragraph + one bulleted link per citation. */
export function markdownToNotionBlocks(
  md: string,
  citations: readonly KbCitation[],
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const line of parseSimpleMarkdown(md)) {
    if (line.kind === "bullet") {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: notionRichText(line.text) },
      });
    } else {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: notionRichText(line.text) },
      });
    }
  }
  if (citations.length > 0) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: notionRichText("Sources:") },
    });
    for (const c of citations) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: notionRichText(citationLabel(c), c.url) },
      });
    }
  }
  return blocks;
}

/** Body → Confluence storage HTML, then a Sources `<p>` + `<ul>` of citation links. */
export function markdownToConfluenceStorage(md: string, citations: readonly KbCitation[]): string {
  const parts: string[] = [];
  let bulletBuffer: string[] = [];
  const flushBullets = (): void => {
    if (bulletBuffer.length === 0) return;
    parts.push(`<ul>${bulletBuffer.map((b) => `<li>${b}</li>`).join("")}</ul>`);
    bulletBuffer = [];
  };
  for (const line of parseSimpleMarkdown(md)) {
    if (line.kind === "bullet") {
      bulletBuffer.push(escapeHtml(line.text));
    } else {
      flushBullets();
      parts.push(`<p>${escapeHtml(line.text)}</p>`);
    }
  }
  flushBullets();
  if (citations.length > 0) {
    parts.push("<p>Sources:</p>");
    const items = citations.map((c) => {
      const label = escapeHtml(citationLabel(c));
      return c.url !== null && c.url !== ""
        ? `<li><a href="${escapeHtml(c.url)}">${label}</a></li>`
        : `<li>${label}</li>`;
    });
    parts.push(`<ul>${items.join("")}</ul>`);
  }
  return parts.join("");
}

/** Parse + validate a citations JSON string into KbCitation[]; tolerant, never throws on shape. */
export function parseCitationsJson(raw: string): KbCitation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: KbCitation[] = [];
  for (const v of parsed) {
    if (v === null || typeof v !== "object") continue;
    const rec = v as Record<string, unknown>;
    const itemId = rec["itemId"];
    const channelId = rec["channelId"];
    const url = rec["url"];
    if (typeof itemId !== "string" || typeof channelId !== "string") continue;
    out.push({ itemId, channelId, url: typeof url === "string" ? url : null });
  }
  return out;
}
