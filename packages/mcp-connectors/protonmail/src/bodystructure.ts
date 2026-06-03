/**
 * Pure BODYSTRUCTURE walkers — extract attachment METADATA (filename, size,
 * mimetype) and locate the first text/plain part for the preview. NEVER touches
 * attachment bytes; operates only on the structure tree imapflow returns.
 */
import type { MailAttachmentMeta } from "./mail-core.ts";

/**
 * imapflow's parsed BODYSTRUCTURE node. Multipart nodes carry `childNodes`; leaf
 * nodes carry `type` (mimetype), `size`, and `disposition`/`dispositionParameters`
 * for attachments. We type the fields we read; the rest is `unknown`.
 */
export interface BodyStructureNode {
  readonly part?: string;
  readonly type?: string;
  readonly size?: number;
  readonly disposition?: string | null;
  readonly dispositionParameters?: Record<string, unknown> | null;
  readonly parameters?: Record<string, unknown> | null;
  readonly childNodes?: readonly BodyStructureNode[] | null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function filenameOf(node: BodyStructureNode): string | null {
  const fromDisp = asString(node.dispositionParameters?.["filename"]);
  if (fromDisp !== null) {
    return fromDisp;
  }
  return asString(node.parameters?.["name"]);
}

function isAttachment(node: BodyStructureNode): boolean {
  const disp = (node.disposition ?? "").toLowerCase();
  if (disp === "attachment" || disp === "inline") {
    return filenameOf(node) !== null;
  }
  return filenameOf(node) !== null;
}

/**
 * Walk the BODYSTRUCTURE tree and collect attachment METADATA only — filename,
 * size, mimetype. Never reads or requests the part body.
 */
export function extractAttachments(
  root: BodyStructureNode | null | undefined,
): MailAttachmentMeta[] {
  const out: MailAttachmentMeta[] = [];
  const stack: BodyStructureNode[] = root ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    const children = node.childNodes ?? null;
    if (children !== null) {
      for (const c of children) {
        stack.push(c);
      }
      continue;
    }
    if (isAttachment(node)) {
      out.push({
        filename: filenameOf(node),
        sizeBytes: typeof node.size === "number" && Number.isFinite(node.size) ? node.size : null,
        mimeType: asString(node.type),
      });
    }
  }
  return out;
}

/**
 * Find the IMAP part key of the first `text/plain` leaf that is NOT an
 * attachment. Returns `"1"` as a conservative default when no structure is
 * available.
 */
export function findTextPlainPart(root: BodyStructureNode | null | undefined): string {
  const stack: BodyStructureNode[] = root ? [root] : [];
  let firstAnyText: string | null = null;
  while (stack.length > 0) {
    const node = stack.shift();
    if (node === undefined) {
      continue;
    }
    const children = node.childNodes ?? null;
    if (children !== null) {
      for (const c of children) {
        stack.push(c);
      }
      continue;
    }
    const type = (node.type ?? "").toLowerCase();
    const part = node.part ?? "1";
    if (type === "text/plain" && !isAttachment(node)) {
      return part;
    }
    if (type.startsWith("text/") && firstAnyText === null && !isAttachment(node)) {
      firstAnyText = part;
    }
  }
  return firstAnyText ?? "1";
}
