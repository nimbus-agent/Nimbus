/**
 * The text of an MCP `CallToolResult` envelope (`{ content: [{ type: "text", text }], isError? }`).
 *
 * Throws on `isError: true` (the text, when present, is the server's error message), on a result
 * with no leading text part, and on text longer than `maxBytes` (UTF-8 bytes). The cap is checked
 * here because a direct `execute` bypasses the dispatcher's own result cap.
 */
export function extractMcpToolText(result: unknown, maxBytes: number): string {
  if (result === null || typeof result !== "object") {
    throw new Error("connector: unexpected MCP tool result shape");
  }
  const rec = result as Record<string, unknown>;
  const content = rec["content"];
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text =
    first !== null && typeof first === "object"
      ? (first as Record<string, unknown>)["text"]
      : undefined;
  if (rec["isError"] === true) {
    const detail = typeof text === "string" ? `: ${text.slice(0, 200)}` : "";
    throw new Error(`connector: MCP tool reported an error${detail}`);
  }
  if (typeof text !== "string") {
    throw new TypeError("connector: unexpected MCP tool result shape");
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`connector: MCP tool result exceeds the ${String(maxBytes)}-byte cap`);
  }
  return text;
}

/** The cap on one MCP tool result (4 MiB): the dispatcher's, and the sync host's direct call. */
export const MCP_TOOL_RESULT_MAX_BYTES = 4 * 1024 * 1024;
