import { plainTextFromHtmlLines } from "../../../string/html-plain-text-lines.ts";
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
 * representations — pick one", and the pick is by TYPE, not by document
 * position: the first child (in document order) that yielded `text/plain`
 * wins; only when NO child yielded `text/plain` does the first child that
 * yielded `text/html` win. A sender is free to list `text/html` before
 * `text/plain` in the parts array, and html→text conversion is lossy, so
 * picking whichever representation happens to come first would silently
 * prefer the lossy one on those messages — the opposite of this function's
 * documented contract (prefer `text/plain`; fall back to `text/html`).
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
  if (isAlternative) {
    // Every child is visited (state.visited must reflect the whole walk),
    // but only ONE representation is kept: the first child that produced
    // plain text, by TYPE not by position — see the docstring above.
    const childResults = parts.map((part) => collect(part, depth + 1, state));
    const plainChild = childResults.find((r) => r.plain.length > 0);
    if (plainChild !== undefined) {
      return { plain: plainChild.plain, html: [] };
    }
    const htmlChild = childResults.find((r) => r.html.length > 0);
    if (htmlChild !== undefined) {
      return { plain: [], html: htmlChild.html };
    }
    return { plain: [], html: [] };
  }

  const acc: Found = { plain: [], html: [] };
  for (const part of parts) {
    const got = collect(part, depth + 1, state);
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
  return plainTextFromHtmlLines(found.html.join("\n"));
}
