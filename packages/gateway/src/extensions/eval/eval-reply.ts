import type { EvalReply } from "@nimbus-dev/registry-format";

const BAD_REPLY: EvalReply = { kind: "failed", reason: "bad-reply" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Map an MCP `tools/call` result to what the scorer judges: the `text` blocks joined by `"\n"`
 * (other block types ignored), `isError` only when it is exactly `true`. Anything that is not an
 * object with a `content` array is `bad-reply`.
 */
export function replyFromMcpResult(result: unknown): EvalReply {
  if (!isRecord(result)) return BAD_REPLY;
  const content = result["content"];
  if (!Array.isArray(content)) return BAD_REPLY;
  const texts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
      texts.push(block["text"]);
    }
  }
  return { kind: "reply", text: texts.join("\n"), isError: result["isError"] === true };
}
