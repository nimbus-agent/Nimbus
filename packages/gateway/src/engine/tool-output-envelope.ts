export interface ToolOutputContext {
  service: string;
  tool: string;
}

/** Escapes a value for a double-quoted envelope attribute. */
export function escapeEnvelopeAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function wrapToolOutput(ctx: ToolOutputContext, result: unknown): string {
  const body = JSON.stringify(result ?? null);
  const safeBody = body.replaceAll("</tool_output>", String.raw`<\/tool_output>`);
  return `<tool_output service="${escapeEnvelopeAttr(ctx.service)}" tool="${escapeEnvelopeAttr(ctx.tool)}">${safeBody}</tool_output>`;
}

/**
 * Rewrites every closer of an I11 block (`</tool_output>`, `</tool_description>`) in
 * server-supplied prose to `<\/…>`, the same escape `wrapToolOutput` applies. The match is wider
 * than `wrapToolOutput`'s exact string, because prose is not JSON-encoded and a model may read any
 * of these as a closer: any case, whitespace after `<` or around `/`, and an attribute-like tail
 * before `>` (`< /TOOL_OUTPUT foo="x">`). Only the `/` changes — a `\` is inserted before it — so
 * the rest of the text is untouched. Any truncation of the result is safe: in every escaped closer
 * the `/` is preceded by `\`, so no prefix of one can form a closer.
 *
 * Stated bound: this is lexical. Lookalikes — a zero-width character inside the tag name, or a
 * fullwidth `／`/`＜` — are not closers to this regex and pass through unchanged; whether a model
 * reads one as a closer is outside what a lexical escape can decide.
 */
export function escapeEnvelopeClosers(text: string): string {
  const closer = /<\s*\/\s*(?:tool_output|tool_description)\b[^>]*>/gi;
  return text.replace(closer, (m) => m.replace("/", String.raw`\/`));
}

/**
 * Delimits a server-supplied tool description as data: `<tool_description server="…">…</tool_description>`.
 * `maxText` caps the ESCAPED text before the closing tag is appended, so a cap can never
 * truncate the closer away (and, per {@link escapeEnvelopeClosers}, can never complete a forged one).
 */
export function wrapToolDescription(
  server: string,
  text: string,
  maxText: number = Number.POSITIVE_INFINITY,
): string {
  const body = escapeEnvelopeClosers(text).slice(0, Math.max(0, maxText));
  return `<tool_description server="${escapeEnvelopeAttr(server)}">${body}</tool_description>`;
}
