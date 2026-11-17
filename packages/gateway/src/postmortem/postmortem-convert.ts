/**
 * Markdown to the two page formats a post-mortem push sends (Phase 10 IC7a): Confluence storage HTML and
 * Notion block JSON. Pure and deterministic; no I/O.
 *
 * A SUBSET on purpose: ATX headings, `-`/`*` list items, fenced code, paragraphs, and inline links,
 * `` `code` ``, bold and italic. Raw HTML in the file is never interpreted: every character is escaped for
 * the target, so a `<script>`, `<img>` or `<iframe>` in an edited draft arrives as text. A link keeps its
 * target only for `http` and `https`; any other scheme keeps its text alone. A Markdown image (`![`) outside
 * a code span is REFUSED rather than dropped, so the owner sees the file did not convert as written. The
 * output therefore never holds an external image, embed, frame or stylesheet; the gateway still runs the
 * remote-content check on the result (B3r) before any prompt.
 */

export class PostmortemConvertError extends Error {
  constructor(
    readonly code:
      | "ERR_POSTMORTEM_PUSH_IMAGE"
      | "ERR_POSTMORTEM_PUSH_TITLE"
      | "ERR_POSTMORTEM_PUSH_EMPTY"
      | "ERR_POSTMORTEM_PUSH_TOO_LARGE",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PostmortemConvertError";
  }
}

export const NOTION_MAX_BLOCKS = 100;
export const NOTION_TEXT_MAX = 2000;
const NOTION_RICH_TEXT_MAX_ITEMS = 100;
const URL_MAX = 2000;
const TITLE_MAX = 200;
export const PUSH_BODY_MAX_BYTES = 256 * 1024;

type Span = {
  readonly text: string;
  readonly href?: string;
  readonly code?: true;
  readonly bold?: true;
  readonly italic?: true;
};

type Block =
  | { readonly kind: "heading"; readonly level: number; readonly spans: readonly Span[] }
  | { readonly kind: "paragraph"; readonly spans: readonly Span[] }
  | { readonly kind: "item"; readonly spans: readonly Span[] }
  | { readonly kind: "code"; readonly text: string };

// Controls (including CR, TAB and LF), format characters (bidi, zero-width) and line or paragraph separators.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Invisible characters out of body text; LF and TAB are kept (a code block needs them). */
function scrub(s: string): string {
  return s.replace(INVISIBLE_RE, (c) => (c === "\n" || c === "\t" ? c : " "));
}

const INLINE_RE = new RegExp(
  [
    String.raw`\\([!-/:-@\[-` + "`" + String.raw`{-~])`, // 1: backslash escape
    String.raw`\[((?:[^\]\\]|\\.)*)\]\(([^)\s]*)\)`, // 2,3: link
    "`([^`]+)`", // 4: code
    String.raw`\*\*([^*]+)\*\*`, // 5: bold
    String.raw`(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])`, // 6: italic
    String.raw`\*([^*\s][^*]*)\*`, // 7: italic
  ].join("|"),
  "g",
);

function unescapeMarkdown(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function safeHref(url: string): string | undefined {
  if (url.length === 0 || url.length > URL_MAX) return undefined;
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : undefined;
}

function inlineSpans(src: string): Span[] {
  const spans: Span[] = [];
  let at = 0;
  const flush = (end: number): void => {
    if (end > at) spans.push({ text: src.slice(at, end) });
  };
  for (const m of src.matchAll(INLINE_RE)) {
    const start = m.index;
    flush(start);
    at = start + m[0].length;
    if (m[1] !== undefined) {
      spans.push({ text: m[1] });
    } else if (m[2] !== undefined) {
      const href = safeHref(m[3] ?? "");
      const text = unescapeMarkdown(m[2]);
      spans.push(href === undefined ? { text } : { text, href });
    } else if (m[4] !== undefined) {
      spans.push({ text: m[4], code: true });
    } else if (m[5] !== undefined) {
      spans.push({ text: unescapeMarkdown(m[5]), bold: true });
    } else {
      spans.push({ text: unescapeMarkdown(m[6] ?? m[7] ?? ""), italic: true });
    }
  }
  flush(src.length);
  // Plain runs still carry backslash escapes only where the regex did not consume them (none left).
  return spans.filter((s) => s.text !== "");
}

function assertNoImage(line: string): void {
  // Outside a code span: a backtick run hides an `![` that is literal text.
  const withoutCode = line.replace(/`[^`]*`/g, "");
  if (withoutCode.includes("![")) {
    throw new PostmortemConvertError(
      "ERR_POSTMORTEM_PUSH_IMAGE",
      "the file holds a Markdown image, which a post-mortem page cannot carry; remove it or use a plain link",
    );
  }
}

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;
const ITEM_RE = /^[ \t]*[-*+][ \t]+(.*)$/;
const FENCE_RE = /^[ \t]*```/;

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length === 0) return;
    blocks.push({ kind: "paragraph", spans: inlineSpans(para.join(" ")) });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (FENCE_RE.test(line)) {
      flushPara();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i] as string)) {
        code.push(lines[i] as string);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    assertNoImage(line);
    const heading = HEADING_RE.exec(line);
    const item = ITEM_RE.exec(line);
    if (heading !== null) {
      flushPara();
      blocks.push({
        kind: "heading",
        level: (heading[1] as string).length,
        spans: inlineSpans(heading[2] as string),
      });
    } else if (item !== null) {
      flushPara();
      blocks.push({ kind: "item", spans: inlineSpans(item[1] as string) });
    } else if (line.trim() === "") {
      flushPara();
    } else {
      para.push(line.replace(/^[ \t]*>[ \t]?/, "").trim());
    }
    i += 1;
  }
  flushPara();
  return blocks.filter((b) => (b.kind === "code" ? true : b.spans.length > 0));
}

/** Escapes text for storage-format element content and attribute values alike. */
function xml(s: string): string {
  return scrub(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function spanHtml(s: Span): string {
  let out = xml(s.text);
  if (s.code === true) out = `<code>${out}</code>`;
  if (s.bold === true) out = `<strong>${out}</strong>`;
  if (s.italic === true) out = `<em>${out}</em>`;
  if (s.href !== undefined) out = `<a href="${xml(s.href)}">${out}</a>`;
  return out;
}

const html = (spans: readonly Span[]): string => spans.map(spanHtml).join("");

/** Confluence storage HTML for the Markdown subset. */
export function toConfluenceStorage(markdown: string): string {
  const out: string[] = [];
  let list: string[] = [];
  const flushList = (): void => {
    if (list.length === 0) return;
    out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const b of parseBlocks(markdown)) {
    if (b.kind === "item") {
      list.push(html(b.spans));
      continue;
    }
    flushList();
    if (b.kind === "heading")
      out.push(`<h${String(b.level)}>${html(b.spans)}</h${String(b.level)}>`);
    else if (b.kind === "paragraph") out.push(`<p>${html(b.spans)}</p>`);
    else out.push(`<pre>${xml(b.text)}</pre>`);
  }
  flushList();
  if (out.length === 0) {
    throw new PostmortemConvertError("ERR_POSTMORTEM_PUSH_EMPTY", "the file has no body to push");
  }
  return out.join("");
}

type RichText = {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: { bold?: true; italic?: true; code?: true };
};

function richText(spans: readonly Span[]): RichText[] {
  const out: RichText[] = [];
  for (const s of spans) {
    const content = scrub(s.text);
    // By code point, so an astral character is never split across two rich-text items.
    const points = Array.from(content);
    for (let at = 0; at < points.length; at += NOTION_TEXT_MAX) {
      const piece = points.slice(at, at + NOTION_TEXT_MAX).join("");
      const item: RichText = { type: "text", text: { content: piece } };
      if (s.href !== undefined) item.text.link = { url: s.href };
      if (s.bold === true || s.italic === true || s.code === true) {
        item.annotations = {
          ...(s.bold === true ? { bold: true as const } : {}),
          ...(s.italic === true ? { italic: true as const } : {}),
          ...(s.code === true ? { code: true as const } : {}),
        };
      }
      out.push(item);
    }
  }
  if (out.length > NOTION_RICH_TEXT_MAX_ITEMS) {
    throw new PostmortemConvertError(
      "ERR_POSTMORTEM_PUSH_TOO_LARGE",
      "a paragraph is too long for one Notion block; shorten it or push to Confluence",
    );
  }
  return out;
}

function notionBlock(b: Block): Record<string, unknown> {
  if (b.kind === "heading") {
    const t = `heading_${String(Math.min(b.level, 3))}`;
    return { object: "block", type: t, [t]: { rich_text: richText(b.spans) } };
  }
  if (b.kind === "item") {
    return {
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: richText(b.spans) },
    };
  }
  if (b.kind === "code") {
    return {
      object: "block",
      type: "code",
      code: { rich_text: richText([{ text: b.text }]), language: "plain text" },
    };
  }
  return { object: "block", type: "paragraph", paragraph: { rich_text: richText(b.spans) } };
}

/** The JSON array (as text) the Notion block append row takes as `childrenJson`. */
export function toNotionBlocksJson(markdown: string): string {
  const blocks = parseBlocks(markdown).filter((b) => b.kind !== "code" || b.text.trim() !== "");
  if (blocks.length === 0) {
    throw new PostmortemConvertError("ERR_POSTMORTEM_PUSH_EMPTY", "the file has no body to push");
  }
  if (blocks.length > NOTION_MAX_BLOCKS) {
    throw new PostmortemConvertError(
      "ERR_POSTMORTEM_PUSH_TOO_LARGE",
      `the page would need ${String(blocks.length)} Notion blocks and one append takes at most ${String(NOTION_MAX_BLOCKS)}; shorten the file or push to Confluence`,
    );
  }
  return JSON.stringify(blocks.map(notionBlock));
}

/** A title from free text: invisible characters removed, trimmed, 1 to 200 code points. */
export function cleanTitle(raw: string): string {
  const t = raw.replace(INVISIBLE_RE, " ").replace(/\s+/g, " ").trim();
  if (t === "" || Array.from(t).length > TITLE_MAX) {
    throw new PostmortemConvertError(
      "ERR_POSTMORTEM_PUSH_TITLE",
      `the page title must be 1 to ${String(TITLE_MAX)} characters`,
    );
  }
  return t;
}

/**
 * Splits the file into its page title and body. A leading `# title` line is the title (and is dropped from
 * the body); `titleOverride` replaces it. With neither, the push is refused.
 */
export function splitTitleAndBody(
  markdown: string,
  titleOverride: string | undefined,
): { readonly title: string; readonly body: string } {
  if (new TextEncoder().encode(markdown).length > PUSH_BODY_MAX_BYTES) {
    throw new PostmortemConvertError(
      "ERR_POSTMORTEM_PUSH_TOO_LARGE",
      "the file is larger than 256 KiB",
    );
  }
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let first = 0;
  while (first < lines.length && (lines[first] as string).trim() === "") first += 1;
  const head = first < lines.length ? /^#[ \t]+(.+?)[ \t#]*$/.exec(lines[first] as string) : null;
  if (head === null && titleOverride === undefined) {
    throw new PostmortemConvertError(
      "ERR_POSTMORTEM_PUSH_TITLE",
      "the file does not start with a '# title' line; add one or pass --title",
    );
  }
  const body = head === null ? lines.join("\n") : lines.slice(first + 1).join("\n");
  const title = cleanTitle(titleOverride ?? unescapeMarkdown(head?.[1] ?? ""));
  return { title, body };
}
