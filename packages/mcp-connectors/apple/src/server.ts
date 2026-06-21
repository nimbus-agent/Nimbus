/**
 * iCloud Mail + Calendar MCP server.
 *
 * Real clients (IMAP/SMTP/CalDAV) are confined here (coverage-excluded).
 * All pure logic lives in apple-mail-core.ts, caldav-core.ts, calendar-tools.ts,
 * and tools.ts which are fully unit-tested.
 *
 * Credentials arrive as env vars injected by the lazy-mesh spawner — never
 * logged, IPC'd, or written to disk.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type ParsedEvent, parseICalendar } from "@nimbus-dev/sdk";
import { type FetchMessageObject, type FetchQueryObject, ImapFlow } from "imapflow";
import { createTransport, type Transporter } from "nodemailer";
import { type DAVCalendar, DAVClient } from "tsdav";
import {
  type BodyStructureNode,
  extractAttachments,
  findTextPlainPart,
} from "../../shared/imap-bodystructure.ts";
import { previewFromParts } from "../../shared/imap-tool-kit.ts";
import { requireProcessEnv } from "../../shared/mcp-tool-kit.ts";
import {
  clampLimit,
  type DraftAppender,
  type DraftInput,
  type DraftResult,
  type EmailReadClient,
  type EmailSendMailer,
  PREVIEW_FETCH_BYTES,
} from "./apple-mail-core.ts";
import type { CalDavClient, CalendarRef, EventWindow } from "./caldav-core.ts";
import { registerAppleTools } from "./tools.ts";

// ---------------------------------------------------------------------------
// Fixed iCloud endpoints
// ---------------------------------------------------------------------------

const ICLOUD_IMAP_HOST = "imap.mail.me.com";
const ICLOUD_IMAP_PORT = 993;
const ICLOUD_SMTP_HOST = "smtp.mail.me.com";
const ICLOUD_SMTP_PORT = 587;
const ICLOUD_CALDAV_BOOTSTRAP_URL = "https://caldav.icloud.com";
const DEFAULT_MAILBOX = "INBOX";
const DRAFTS_MAILBOX = "Drafts";

// ---------------------------------------------------------------------------
// imapflow message-shaping helpers
// (copied locally; cross-importing ../../imap/src/* is forbidden per review #1
//  and package isolation rules; server.ts is coverage-excluded so this copy
//  is acceptable)
// ---------------------------------------------------------------------------

/**
 * Build an address record from an imapflow envelope address, omitting
 * name/address when absent (exactOptionalPropertyTypes is on — explicit
 * undefined is not assignable).
 */
function toImapAddressLocal(a: { name?: string; address?: string }): {
  name?: string;
  address?: string;
} {
  const out: { name?: string; address?: string } = {};
  if (a.name !== undefined) {
    out.name = a.name;
  }
  if (a.address !== undefined) {
    out.address = a.address;
  }
  return out;
}

function envelopeFromImap(env: FetchMessageObject["envelope"]): {
  date?: Date | null;
  subject?: string | null;
  messageId?: string | null;
  from?: { name?: string; address?: string }[];
  to?: { name?: string; address?: string }[];
  cc?: { name?: string; address?: string }[];
} {
  if (env === undefined) {
    return {};
  }
  return {
    date: env.date ?? null,
    subject: env.subject ?? null,
    messageId: env.messageId ?? null,
    from: (env.from ?? []).map(toImapAddressLocal),
    to: (env.to ?? []).map(toImapAddressLocal),
    cc: (env.cc ?? []).map(toImapAddressLocal),
  };
}

function toMessageMeta(
  msg: FetchMessageObject,
  mailbox: string,
  uidValidity: string | null,
): {
  uid: number;
  mailbox: string;
  uidValidity: string | null;
  envelope: ReturnType<typeof envelopeFromImap>;
  attachments: { filename: string | null; sizeBytes: number | null; mimeType: string | null }[];
  preview: string;
} {
  const structure = (msg.bodyStructure ?? null) as BodyStructureNode | null;
  const partKey = findTextPlainPart(structure);
  return {
    uid: msg.uid,
    mailbox,
    uidValidity,
    envelope: envelopeFromImap(msg.envelope),
    attachments: extractAttachments(structure),
    preview: previewFromParts(msg.bodyParts, partKey),
  };
}

/**
 * Fetch query requesting ONLY headers + structure + a truncated text body part.
 * No source / full-body request by construction.
 */
function previewFetchQuery(): FetchQueryObject {
  return {
    uid: true,
    envelope: true,
    bodyStructure: true,
    internalDate: true,
    bodyParts: [
      { key: "1", start: 0, maxLength: PREVIEW_FETCH_BYTES },
      { key: "TEXT", start: 0, maxLength: PREVIEW_FETCH_BYTES },
    ],
  };
}

// ---------------------------------------------------------------------------
// EmailReadClient — imapflow over imap.mail.me.com:993 (TLS)
// ---------------------------------------------------------------------------

class AppleImapClient implements EmailReadClient {
  private readonly config: {
    host: string;
    port: number;
    user: string;
    pass: string;
  };

  constructor(user: string, pass: string) {
    this.config = {
      host: ICLOUD_IMAP_HOST,
      port: ICLOUD_IMAP_PORT,
      user,
      pass,
    };
  }

  private newFlow(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
    });
  }

  private async withMailbox<T>(
    mailbox: string,
    fn: (client: ImapFlow, uidValidity: string | null) => Promise<T>,
  ): Promise<T> {
    const flow = this.newFlow();
    await flow.connect();
    const lock = await flow.getMailboxLock(mailbox);
    try {
      const mb = flow.mailbox;
      const uidValidity = mb === false ? null : String(mb.uidValidity);
      return await fn(flow, uidValidity);
    } finally {
      lock.release();
      await flow.logout();
    }
  }

  async list(options: {
    mailbox?: string;
    limit?: number;
  }): Promise<ReturnType<typeof toMessageMeta>[]> {
    const mailbox = options.mailbox ?? DEFAULT_MAILBOX;
    const limit = clampLimit(options.limit);
    return this.withMailbox(mailbox, async (flow, uidValidity) => {
      const out: ReturnType<typeof toMessageMeta>[] = [];
      const status = await flow.status(mailbox, { messages: true });
      const total = status.messages ?? 0;
      if (total === 0) {
        return out;
      }
      const start = Math.max(1, total - limit + 1);
      const range = `${start}:${total}`;
      for await (const msg of flow.fetch(range, previewFetchQuery())) {
        out.push(toMessageMeta(msg, mailbox, uidValidity));
      }
      out.sort((a, b) => b.uid - a.uid);
      return out;
    });
  }

  async get(uid: number, mailbox?: string): Promise<ReturnType<typeof toMessageMeta> | null> {
    const box = mailbox ?? DEFAULT_MAILBOX;
    return this.withMailbox(box, async (flow, uidValidity) => {
      const msg = await flow.fetchOne(String(uid), previewFetchQuery(), { uid: true });
      return msg === false ? null : toMessageMeta(msg, box, uidValidity);
    });
  }

  async search(options: {
    query: string;
    mailbox?: string;
    limit?: number;
  }): Promise<ReturnType<typeof toMessageMeta>[]> {
    const mailbox = options.mailbox ?? DEFAULT_MAILBOX;
    const limit = clampLimit(options.limit);
    const q = options.query;
    return this.withMailbox(mailbox, async (flow, uidValidity) => {
      const uids = await flow.search(
        { or: [{ subject: q }, { from: q }, { to: q }] },
        { uid: true },
      );
      if (uids === false || uids.length === 0) {
        return [];
      }
      const picked = uids.slice(-limit).sort((a, b) => b - a);
      const out: ReturnType<typeof toMessageMeta>[] = [];
      for await (const msg of flow.fetch(picked, previewFetchQuery(), { uid: true })) {
        out.push(toMessageMeta(msg, mailbox, uidValidity));
      }
      out.sort((a, b) => b.uid - a.uid);
      return out;
    });
  }
}

// ---------------------------------------------------------------------------
// EmailSendMailer — nodemailer over smtp.mail.me.com:587 (STARTTLS)
// From is PINNED to the authenticated icloud_email (forced sender contract).
// ---------------------------------------------------------------------------

class AppleSmtpMailer implements EmailSendMailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(user: string, pass: string) {
    this.from = user;
    this.transport = createTransport({
      host: ICLOUD_SMTP_HOST,
      port: ICLOUD_SMTP_PORT,
      // STARTTLS — secure:false, port 587 (not 465).
      secure: false,
      auth: { user, pass },
    });
  }

  async send(input: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
  }): Promise<{
    messageId: string | null;
    accepted: readonly string[];
    rejected: readonly string[];
  }> {
    const info = await this.transport.sendMail({
      // From is always pinned to the authenticated iCloud email — callers cannot
      // override it (forced sender contract per Global Constraints §Forced sender).
      from: this.from,
      to: input.to,
      subject: input.subject,
      text: input.body,
      ...(input.cc === undefined ? {} : { cc: input.cc }),
      ...(input.bcc === undefined ? {} : { bcc: input.bcc }),
    });
    return {
      messageId: info.messageId ?? null,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  }
}

// ---------------------------------------------------------------------------
// DraftAppender — IMAP APPEND to "Drafts" via imapflow
// From is PINNED to the authenticated icloud_email (forced sender contract).
// ---------------------------------------------------------------------------

/**
 * Build a minimal RFC 5322 message from the given inputs.
 * The From header is always set to `from` (the pinned icloud_email).
 */
function buildRfc822Message(from: string, input: DraftInput): string {
  const lines: string[] = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${input.to}`);
  if (input.cc !== undefined && input.cc !== "") {
    lines.push(`Cc: ${input.cc}`);
  }
  if (input.bcc !== undefined && input.bcc !== "") {
    lines.push(`Bcc: ${input.bcc}`);
  }
  lines.push(`Subject: ${input.subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(input.body);
  // RFC 5322 uses CRLF line endings.
  return lines.join("\r\n");
}

class AppleDraftAppender implements DraftAppender {
  private readonly config: {
    host: string;
    port: number;
    user: string;
    pass: string;
  };
  private readonly from: string;

  constructor(user: string, pass: string) {
    this.from = user;
    this.config = {
      host: ICLOUD_IMAP_HOST,
      port: ICLOUD_IMAP_PORT,
      user,
      pass,
    };
  }

  async appendDraft(input: DraftInput): Promise<DraftResult> {
    const flow = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
    });

    await flow.connect();
    try {
      // Build the RFC 5322 message with From pinned to the authenticated email.
      const raw = buildRfc822Message(this.from, input);
      const buf = Buffer.from(raw, "utf8");

      // IMAP APPEND to the Drafts mailbox. imapflow returns the assigned UID
      // when the server supports APPENDUID or UIDPLUS — it may return undefined
      // when neither is available, which is valid.
      const result = await flow.append(DRAFTS_MAILBOX, buf, ["\\Draft"]);
      // imapflow append() returns { uid?: number; ... } or undefined.
      const uid = (result as { uid?: number } | undefined)?.uid ?? null;
      return { uid: uid === undefined ? null : uid, mailbox: DRAFTS_MAILBOX };
    } finally {
      await flow.logout();
    }
  }
}

// ---------------------------------------------------------------------------
// CalDavClient — tsdav DAVClient (two-phase: bootstrap discover then working)
//
// Per review #2: iCloud CalDAV authenticates against caldav.icloud.com but
// redirects to a user-specific host (p##-caldav.icloud.com). login() resolves
// the principal + calendar-home-set and binds the credentials to the resolved
// host so that Basic auth is applied to the resolved host on every subsequent
// request — without relying on transparent cross-host redirect forwarding.
// ---------------------------------------------------------------------------

class TsdavCalDavClient implements CalDavClient {
  /**
   * Discovered DAVCalendar objects keyed by their url. Populated after the
   * first listCalendars() call so that putEvent/listEvents can obtain the
   * full DAVCalendar object (which carries the account reference that tsdav
   * needs for auth on the resolved p##-caldav.icloud.com host).
   */
  private discovered: Map<string, DAVCalendar> = new Map();
  private readonly davClient: DAVClient;

  constructor(email: string, appPw: string) {
    // login() will perform principal + calendar-home discovery and bind the
    // credentials to all subsequent requests against the resolved
    // p##-caldav.icloud.com host — satisfying the auth-on-redirect requirement.
    this.davClient = new DAVClient({
      serverUrl: ICLOUD_CALDAV_BOOTSTRAP_URL,
      credentials: { username: email, password: appPw },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
  }

  async login(): Promise<void> {
    await this.davClient.login();
  }

  async listCalendars(): Promise<CalendarRef[]> {
    const cals = await this.davClient.fetchCalendars();
    // Refresh the discovery cache.
    this.discovered = new Map();
    for (const cal of cals) {
      this.discovered.set(cal.url, cal);
    }
    return cals.map((cal) => ({
      url: cal.url,
      displayName:
        typeof cal.displayName === "string" && cal.displayName !== "" ? cal.displayName : cal.url,
    }));
  }

  /**
   * Resolve a CalendarRef to the underlying DAVCalendar tsdav needs.
   * If not found in cache, constructs a minimal DAVCalendar using just the url
   * (tsdav fetchCalendarObjects only strictly requires `calendar.url`).
   */
  private toDavCalendar(cal: CalendarRef): DAVCalendar {
    const found = this.discovered.get(cal.url);
    if (found !== undefined) {
      return found;
    }
    // Construct a minimal DAVCalendar — tsdav only requires `.url` for
    // fetchCalendarObjects, createCalendarObject, and deleteCalendarObject.
    return { url: cal.url };
  }

  async listEvents(
    cal: CalendarRef,
    window: EventWindow,
  ): Promise<{ href: string; event: ParsedEvent }[]> {
    const davCal = this.toDavCalendar(cal);
    const objects = await this.davClient.fetchCalendarObjects({
      calendar: davCal,
      timeRange: { start: window.startUtc, end: window.endUtc },
      // expand: true triggers server-side recurrence expansion (C:expand in
      // the REPORT) — required per spec; no client-side RRULE engine.
      expand: true,
    });

    const results: { href: string; event: ParsedEvent }[] = [];
    for (const obj of objects) {
      if (typeof obj.data !== "string" || obj.data === "") {
        continue;
      }
      const events = parseICalendar(obj.data);
      for (const event of events) {
        results.push({ href: obj.url, event });
      }
    }
    return results;
  }

  async putEvent(cal: CalendarRef, uid: string, ics: string): Promise<{ href: string }> {
    const davCal = this.toDavCalendar(cal);
    const filename = `${uid}.ics`;
    await this.davClient.createCalendarObject({
      calendar: davCal,
      iCalString: ics,
      filename,
    });
    // The href of the newly created object is conventionally the calendar URL
    // joined with the filename. tsdav does not return a Location header
    // wrapper, so we construct it from the calendar URL.
    const href = cal.url.endsWith("/") ? `${cal.url}${filename}` : `${cal.url}/${filename}`;
    return { href };
  }

  async deleteEvent(href: string): Promise<void> {
    // etag: "" means "unconditional delete" — acceptable because we don't track
    // etags in the CalendarRef/EventWindow flow.
    await this.davClient.deleteCalendarObject({
      calendarObject: { url: href, etag: "" },
    });
  }
}

// ---------------------------------------------------------------------------
// Bootstrap + register + connect
// ---------------------------------------------------------------------------

const email = requireProcessEnv("APPLE_ICLOUD_EMAIL");
const appPw = requireProcessEnv("APPLE_ICLOUD_APP_PASSWORD");

const client = new AppleImapClient(email, appPw);
const mailer = new AppleSmtpMailer(email, appPw);
const draftAppender = new AppleDraftAppender(email, appPw);

const tsdavClient = new TsdavCalDavClient(email, appPw);
// Perform CalDAV principal + calendar-home discovery so that subsequent
// requests are authenticated against the resolved p##-caldav.icloud.com host.
await tsdavClient.login();
// Warm the calendar cache at boot so a cold apple_calendar_event_create/delete
// (before any apple_calendar_list) resolves a fully-formed DAVCalendar (with its
// account binding) rather than a bare { url } that could fail auth on the
// resolved host. Best-effort: ignore discovery errors here (tools re-discover).
try {
  await tsdavClient.listCalendars();
} catch {
  // non-fatal; listEvents/list tools will re-discover on demand
}

const calendar: CalDavClient = tsdavClient;
// iCalendar DTSTAMP format (RFC 5545): YYYYMMDDTHHMMSSZ — buildVEvent emits the
// value verbatim, so it must NOT be ISO-8601 (no hyphens/colons/milliseconds).
const now = (): string =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

const server = new McpServer({ name: "nimbus-apple", version: "0.1.0" });

registerAppleTools(server, { client, mailer, draftAppender, calendar, now });

await server.connect(new StdioServerTransport());
