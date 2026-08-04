import { plainTextFromHtml } from "../../../string/html-plain-text.ts";
import type { MessagePayload } from "./api.ts";

/** Depth bound — a malformed or hostile tree must not be able to spin. */
const MAX_DEPTH = 12;
/** Total parts visited across the whole walk. */
const MAX_PARTS = 500;

function decodeBase64Url(data: string): string {
  // Gmail encodes part bodies base64url (`-`/`_`), NOT standard base64.
  return Buffer.from(data, "base64url").toString("utf8");
}

/** Text collected from one subtree: plain and html candidates, each a sequence. */
type Found = { plain: string[]; html: string[] };

function leafText(node: MessagePayload): Found {
  const out: Found = { plain: [], html: [] };
  const data = node.body?.data;
  // Gmail does not inline attachment bytes here, and filenames are not what we
  // index — skip any part that defers to a separate attachment fetch.
  if (node.body?.attachmentId !== undefined || data === undefined || data === "") {
    return out;
  }
  const mime = node.mimeType ?? "";
  if (mime.startsWith("text/plain")) {
    out.plain.push(decodeBase64Url(data));
  } else if (mime.startsWith("text/html")) {
    out.html.push(decodeBase64Url(data));
  }
  return out;
}

/**
 * Collect text honouring MIME container semantics.
 *
 * `multipart/alternative` means "these are the SAME content in different
 * representations — pick one", so the first child that yields anything wins.
 * `multipart/mixed` and `multipart/related` mean "these are a SEQUENCE", so
 * their children concatenate in order.
 *
 * Taking only the first text part regardless of container would silently drop
 * body text on any message interleaving prose with inline parts — the same
 * class of quiet truncation this workstream exists to remove.
 */
function collect(node: MessagePayload, depth: number, state: { visited: number }): Found {
  if (depth > MAX_DEPTH || state.visited >= MAX_PARTS) {
    return { plain: [], html: [] };
  }
  state.visited += 1;

  const parts = node.parts ?? [];
  if (parts.length === 0) {
    return leafText(node);
  }

  const isAlternative = (node.mimeType ?? "").startsWith("multipart/alternative");
  const acc: Found = { plain: [], html: [] };
  for (const part of parts) {
    const got = collect(part, depth + 1, state);
    if (isAlternative) {
      // First child that produced anything wins; ignore the rest.
      if (got.plain.length > 0 || got.html.length > 0) {
        if (acc.plain.length === 0 && acc.html.length === 0) {
          acc.plain.push(...got.plain);
          acc.html.push(...got.html);
        }
      }
      continue;
    }
    acc.plain.push(...got.plain);
    acc.html.push(...got.html);
  }
  return acc;
}

/**
 * Plain text for a Gmail message payload. Prefers `text/plain`; falls back to
 * `text/html` stripped to text.
 */
export function gmailMessageBodyText(payload: MessagePayload): string {
  const found = collect(payload, 0, { visited: 0 });
  if (found.plain.length > 0) {
    return found.plain.join("\n").trim();
  }
  if (found.html.length === 0) {
    return "";
  }
  return plainTextFromHtml(found.html.join("\n"));
}
