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

export function capPreview(text: string): string {
  const normalized = text
    .replaceAll("\r\n", "\n")
    .replaceAll(/[ \t]+/g, " ")
    .replaceAll(/\n{2,}/g, "\n")
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

/** Return a node's child structure parts, or `null` if it is a leaf part. */
function childPartsOf(node: MessageStructureObject): MessageStructureObject[] | null {
  return node.childNodes && node.childNodes.length > 0 ? node.childNodes : null;
}

/** Collect every leaf part of the structure tree in document (pre-)order. */
function leafParts(root: MessageStructureObject | undefined): MessageStructureObject[] {
  const leaves: MessageStructureObject[] = [];
  const walk = (node: MessageStructureObject): void => {
    const children = childPartsOf(node);
    if (children === null) {
      leaves.push(node);
      return;
    }
    for (const c of children) {
      walk(c);
    }
  };
  if (root !== undefined) {
    walk(root);
  }
  return leaves;
}

function attachmentMetaOf(node: MessageStructureObject): ImapAttachmentMeta {
  return {
    filename: filenameOf(node),
    sizeBytes: typeof node.size === "number" ? node.size : null,
    mimeType: typeof node.type === "string" && node.type !== "" ? node.type : null,
  };
}

export function extractAttachments(root: MessageStructureObject | undefined): ImapAttachmentMeta[] {
  return leafParts(root).filter(isAttachment).map(attachmentMetaOf);
}

export function findTextPlainPart(root: MessageStructureObject | undefined): string {
  let firstText: string | null = null;
  for (const node of leafParts(root)) {
    if (isAttachment(node)) {
      continue;
    }
    const type = (node.type ?? "").toLowerCase();
    const part = node.part ?? "1";
    if (type === "text/plain") {
      return part;
    }
    if (firstText === null && type.startsWith("text/")) {
      firstText = part;
    }
  }
  return firstText ?? "1";
}

export function previewFromParts(parts: Map<string, Buffer> | undefined, partKey: string): string {
  if (parts === undefined) {
    return "";
  }
  const buf = parts.get(partKey) ?? parts.get("1") ?? parts.get("TEXT");
  return buf === undefined ? "" : capPreview(buf.toString("utf8"));
}

export function addresses(list: { name?: string; address?: string }[] | undefined): string[] {
  return (list ?? []).map((a) => {
    const addr = a.address ?? "";
    if (a.name !== undefined && a.name !== "") {
      return addr === "" ? a.name : `${a.name} <${addr}>`;
    }
    return addr;
  });
}

export function toInput(
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
 * The slice of {@link ImapFlow} the fetcher actually drives. Declared
 * structurally so tests can inject a fake without opening a socket; the real
 * `ImapFlow` instance satisfies it.
 */
export interface ImapClientLike {
  connect(): Promise<void>;
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  readonly mailbox: { readonly uidValidity: number | bigint; readonly exists: number } | false;
  fetch(range: string, query: FetchQueryObject): AsyncIterable<FetchMessageObject>;
  logout(): Promise<void>;
}

/** Constructs the IMAP client for a connection config (injectable for tests). */
export type ImapClientFactory = (config: ImapConnectionConfig) => ImapClientLike;

const defaultImapClientFactory: ImapClientFactory = (config) =>
  new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure ?? true,
    auth: { user: config.username, pass: config.password },
    logger: false,
    ...(config.tlsRejectUnauthorized === false ? { tls: { rejectUnauthorized: false } } : {}),
  });

/**
 * Production IMAP fetcher: connect, lock the mailbox, fetch the most-recent
 * `limit` messages (headers + attachment metadata + truncated preview), then
 * log out. Returns `{ ok: false }` on any failure instead of throwing. The
 * client factory is injectable so the connect/fetch/error paths are testable
 * without a real socket.
 */
export async function fetchImapMessages(
  config: ImapConnectionConfig,
  limit: number,
  makeClient: ImapClientFactory = defaultImapClientFactory,
): Promise<ImapFetchOutcome> {
  const client = makeClient(config);

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
