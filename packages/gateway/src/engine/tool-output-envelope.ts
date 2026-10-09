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
 * server-supplied prose to `<\/…>`, the same escape `wrapToolOutput` applies — case-insensitively
 * and tolerating whitespace before `>`, since prose is not JSON-encoded and a model may read
 * `</TOOL_DESCRIPTION >` as a closer. Any truncation of the result is safe: every escaped closer
 * carries `\` immediately after `<`, so no prefix of one can form a closer.
 */
export function escapeEnvelopeClosers(text: string): string {
  const closer = /<\/(\s*(?:tool_output|tool_description)\s*)>/gi;
  return text.replace(closer, String.raw`<\/$1>`);
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
