/**
 * Real IMAP fetcher over imapflow for the gateway sync handler. Fetches HEADERS
 * (ENVELOPE) + attachment METADATA (BODYSTRUCTURE) + a single truncated
 * text/plain body part for the preview. NEVER fetches `BODY[]` or an attachment
 * part, so no attachment bytes ever reach the gateway. Returns a structured
 * `{ ok }` outcome and never throws on connection failure — the scheduler
 * tolerates transient IMAP outages.
 */
import {
  type FetchMessageObject,
  type FetchQueryObject,
  ImapFlow,
  type MessageStructureObject,
} from "imapflow";

import type { ImapAttachmentMeta, ImapMessageInput } from "../imap-email-mapping.ts";
import type { ImapConnectionConfig, ImapFetchOutcome } from "../imap-sync.ts";

const PREVIEW_FETCH_BYTES = 2048;
const PREVIEW_MAX_CHARS = 2000;

function capPreview(text: string): string {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return normalized.length > PREVIEW_MAX_CHARS
    ? normalized.slice(0, PREVIEW_MAX_CHARS)
    : normalized;
}

function filenameOf(node: MessageStructureObject): string | null {
  const disp = node.dispositionParameters?.["filename"];
  if (typeof disp === "string" && disp !== "") {
    return disp;
  }
  const name = node.parameters?.["name"];
  return typeof name === "string" && name !== "" ? name : null;
}

function isAttachment(node: MessageStructureObject): boolean {
  return filenameOf(node) !== null;
}

function extractAttachments(root: MessageStructureObject | undefined): ImapAttachmentMeta[] {
  const out: ImapAttachmentMeta[] = [];
  const stack: MessageStructureObject[] = root ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    if (node.childNodes && node.childNodes.length > 0) {
      for (const c of node.childNodes) {
        stack.push(c);
      }
      continue;
    }
    if (isAttachment(node)) {
      out.push({
        filename: filenameOf(node),
        sizeBytes: typeof node.size === "number" ? node.size : null,
        mimeType: typeof node.type === "string" && node.type !== "" ? node.type : null,
      });
    }
  }
  return out;
}

function findTextPlainPart(root: MessageStructureObject | undefined): string {
  const queue: MessageStructureObject[] = root ? [root] : [];
  let firstText: string | null = null;
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) {
      continue;
    }
    if (node.childNodes && node.childNodes.length > 0) {
      for (const c of node.childNodes) {
        queue.push(c);
      }
      continue;
    }
    const type = (node.type ?? "").toLowerCase();
    const part = node.part ?? "1";
    if (type === "text/plain" && !isAttachment(node)) {
      return part;
    }
    if (type.startsWith("text/") && firstText === null && !isAttachment(node)) {
      firstText = part;
    }
  }
  return firstText ?? "1";
}

function previewFromParts(parts: Map<string, Buffer> | undefined, partKey: string): string {
  if (parts === undefined) {
    return "";
  }
  const buf = parts.get(partKey) ?? parts.get("1") ?? parts.get("TEXT");
  return buf === undefined ? "" : capPreview(buf.toString("utf8"));
}

function addresses(list: { name?: string; address?: string }[] | undefined): string[] {
  return (list ?? []).map((a) => {
    const addr = a.address ?? "";
    if (a.name !== undefined && a.name !== "") {
      return addr === "" ? a.name : `${a.name} <${addr}>`;
    }
    return addr;
  });
}

function toInput(
  msg: FetchMessageObject,
  mailbox: string,
  uidValidity: string | null,
): ImapMessageInput {
  const env = msg.envelope;
  const structure = msg.bodyStructure;
  const partKey = findTextPlainPart(structure);
  return {
    uid: msg.uid,
    mailbox,
    uidValidity,
    messageId: env?.messageId ?? null,
    subject: env?.subject ?? null,
    date: env?.date instanceof Date ? env.date.toISOString() : (env?.date ?? null),
    from: addresses(env?.from),
    to: addresses(env?.to),
    cc: addresses(env?.cc),
    attachments: extractAttachments(structure),
    preview: previewFromParts(msg.bodyParts, partKey),
  };
}

const PREVIEW_QUERY: FetchQueryObject = {
  uid: true,
  envelope: true,
  bodyStructure: true,
  internalDate: true,
  bodyParts: [
    { key: "1", start: 0, maxLength: PREVIEW_FETCH_BYTES },
    { key: "TEXT", start: 0, maxLength: PREVIEW_FETCH_BYTES },
  ],
};

/**
 * Production IMAP fetcher: connect, lock the mailbox, fetch the most-recent
 * `limit` messages (headers + attachment metadata + truncated preview), then
 * log out. Returns `{ ok: false }` on any failure instead of throwing.
 */
export async function fetchImapMessages(
  config: ImapConnectionConfig,
  limit: number,
): Promise<ImapFetchOutcome> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.username, pass: config.password },
    logger: false,
  });

  try {
    await client.connect();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      const mb = client.mailbox;
      const uidValidity = mb === false ? null : String(mb.uidValidity);
      const total = mb === false ? 0 : mb.exists;
      if (total === 0) {
        return { ok: true, messages: [] };
      }
      const start = Math.max(1, total - limit + 1);
      const range = `${start}:${total}`;
      const messages: ImapMessageInput[] = [];
      for await (const msg of client.fetch(range, PREVIEW_QUERY)) {
        messages.push(toInput(msg, config.mailbox, uidValidity));
      }
      messages.sort((a, b) => b.uid - a.uid);
      return { ok: true, messages };
    } finally {
      lock.release();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      await client.logout();
    } catch {
      // Best-effort logout; ignore.
    }
  }
}
