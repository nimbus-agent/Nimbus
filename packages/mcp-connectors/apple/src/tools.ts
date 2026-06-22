import { z } from "zod";

import { headerLine } from "../../shared/header-safe.ts";
import { registerEmailConnectorTools } from "../../shared/imap-tool-kit.ts";
import { createRegisterSimpleTool, mcpJsonResult } from "../../shared/mcp-tool-kit.ts";
import {
  type DraftAppender,
  type EmailReadClient,
  type EmailSendMailer,
  formatAddress,
} from "./apple-mail-core.ts";
import type { CalDavClient } from "./caldav-core.ts";
import { type CalendarToolConfig, registerAppleCalendarTools } from "./calendar-tools.ts";

// ---------------------------------------------------------------------------
// Zod schema for the draft tool
// ---------------------------------------------------------------------------

const draftArgs = z.object({
  to: headerLine({ min: 1 }),
  subject: headerLine({ min: 1, max: 998 }),
  body: z.string().max(1_000_000),
  cc: headerLine().optional(),
  bcc: headerLine().optional(),
});

// ---------------------------------------------------------------------------
// Tool descriptions
// ---------------------------------------------------------------------------

const descriptions = {
  list: "List recent iCloud Mail messages — HEADERS + attachment METADATA + a short capped text preview ONLY. Returns subject, from, to/cc, date, message-id, attachment {filename,size,mimetype}, and a <=2000-char plain-text body preview. NEVER returns attachment bytes or the full message body.",
  get: "Fetch one iCloud Mail message by uid — HEADERS + attachment METADATA + a short capped text preview ONLY. NEVER returns attachment bytes or the full message body.",
  search:
    "Substring search over iCloud Mail message HEADERS (subject/from/to) — returns the same header + attachment-metadata + preview view as apple_list. Searches headers only; NEVER scans or returns document/body content beyond the capped preview.",
  send: "Send a new email via iCloud Mail (SMTP). Requires Gateway HITL email.send.",
} as const;

// ---------------------------------------------------------------------------
// Connector params type (mail + calendar)
// ---------------------------------------------------------------------------

export interface AppleToolsParams {
  readonly client: EmailReadClient;
  readonly mailer: EmailSendMailer;
  readonly draftAppender: DraftAppender;
  readonly calendar: CalDavClient;
  readonly now: () => string;
  readonly calendarConfig?: CalendarToolConfig;
}

/**
 * Register all Apple connector tools onto an MCP server:
 * - Mail read tools (list/get/search) via the shared kit
 * - Mail write tools (mail_send, mail_draft_create)
 * - Calendar tools (calendar_list, calendar_event_create, calendar_event_delete)
 *
 * All three calendar tools are registered via registerAppleCalendarTools (Task C3).
 */
export function registerAppleTools(
  server: { tool: (...args: never) => unknown },
  params: AppleToolsParams,
): void {
  const { client, mailer, draftAppender, calendar, now, calendarConfig } = params;

  // The four shared email tools (list/get/search/mail_send) via the shared kit.
  registerEmailConnectorTools({
    server,
    toolPrefix: "apple",
    descriptions,
    client,
    mailer,
    formatAddr: formatAddress,
  });

  // apple_mail_draft_create — iCloud-specific IMAP APPEND to Drafts.
  const registerSimpleTool = createRegisterSimpleTool(server);

  registerSimpleTool(
    "apple_mail_draft_create",
    "Save a new email to the iCloud Mail Drafts folder via IMAP APPEND. Requires Gateway HITL email.draft.create.",
    draftArgs.shape,
    async (args: unknown) => {
      const parsed = draftArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const input: {
        to: string;
        subject: string;
        body: string;
        cc?: string;
        bcc?: string;
      } = {
        to: parsed.data.to,
        subject: parsed.data.subject,
        body: parsed.data.body,
      };
      if (parsed.data.cc !== undefined && parsed.data.cc !== "") {
        input.cc = parsed.data.cc;
      }
      if (parsed.data.bcc !== undefined && parsed.data.bcc !== "") {
        input.bcc = parsed.data.bcc;
      }
      const result = await draftAppender.appendDraft(input);
      return mcpJsonResult({ item: result });
    },
  );

  // apple_calendar_list, apple_calendar_event_create, apple_calendar_event_delete
  registerAppleCalendarTools(server, {
    calendar,
    now,
    config: calendarConfig,
  });
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const APPLE_TOOL_NAMES = [
  "apple_list",
  "apple_get",
  "apple_search",
  "apple_mail_send",
  "apple_mail_draft_create",
  "apple_calendar_list",
  "apple_calendar_event_create",
  "apple_calendar_event_delete",
] as const;
