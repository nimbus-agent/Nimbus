/**
 * nimbus-mcp-outlook — Microsoft Graph mail, calendar, contacts (read + guarded writes).
 * Access token is injected as MICROSOFT_OAUTH_ACCESS_TOKEN (never logged).
 * Optional `MICROSOFT_OAUTH_SCOPES` (space-separated) gates which tools register; the Gateway
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * sets it from `microsoft.oauth` JSON when `scopes` is present.
 * Send / calendar mutations require Gateway HITL (email.send, calendar.event.create | delete).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { headerLine } from "../../shared/header-safe.ts";
import {
  createRegisterSimpleTool,
  type McpListResult,
  mcpJsonResult,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";
import { makeRestFetcher } from "../../shared/rest-tool-kit.ts";
import {
  outlookToolShouldRegister,
  parseMicrosoftOAuthScopesFromEnv,
} from "./tool-scope-policy.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

function graphRequest(
  token: string,
  pathOrUrl: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  return makeRestFetcher({ apiBase: GRAPH, token })(pathOrUrl, init);
}

const server = new McpServer({ name: "nimbus-outlook", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);
const grantedOutlookScopes = parseMicrosoftOAuthScopesFromEnv();

const outlookMailFoldersArgs = z.object({
  top: z.number().int().min(1).max(200).optional(),
  nextLink: z.url().optional(),
});

if (outlookToolShouldRegister("outlook_mail_folders", grantedOutlookScopes)) {
  registerSimpleTool(
    "outlook_mail_folders",
    "List mail folders (pagination via nextLink).",
    outlookMailFoldersArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = outlookMailFoldersArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
      let path: string;
      if (parsed.data.nextLink !== undefined && parsed.data.nextLink !== "") {
        path = parsed.data.nextLink;
      } else {
        const top = parsed.data.top ?? 50;
        path = `/me/mailFolders?$top=${String(top)}`;
      }
      const r = await graphRequest(token, path);
      if (!r.ok) {
        throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
      }
      return mcpJsonResult(r.json);
    },
  );
}

const outlookMailListArgs = z.object({
  folderId: z.string().min(1).optional(),
  top: z.number().int().min(1).max(100).optional(),
  skip: z.number().int().min(0).optional(),
  nextLink: z.url().optional(),
  filter: z.string().max(500).optional(),
});

if (outlookToolShouldRegister("outlook_mail_list", grantedOutlookScopes)) {
  registerSimpleTool(
    "outlook_mail_list",
    "List mail messages (default folder inbox if folderId omitted). Pagination via nextLink.",
    outlookMailListArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = outlookMailListArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
      const top = parsed.data.top ?? 25;
      let path: string;
      if (parsed.data.nextLink !== undefined && parsed.data.nextLink !== "") {
        path = parsed.data.nextLink;
      } else {
        const fid =
          parsed.data.folderId !== undefined && parsed.data.folderId !== ""
            ? parsed.data.folderId
            : "inbox";
        const skip = parsed.data.skip ?? 0;
        const u = new URL(`${GRAPH}/me/mailFolders/${encodeURIComponent(fid)}/messages`);
        u.searchParams.set("$top", String(top));
        u.searchParams.set("$skip", String(skip));
        u.searchParams.set(
          "$select",
          "id,subject,bodyPreview,receivedDateTime,lastModifiedDateTime,hasAttachments,webLink",
        );
        if (parsed.data.filter !== undefined && parsed.data.filter !== "") {
          u.searchParams.set("$filter", parsed.data.filter);
        }
        path = `${u.pathname}${u.search}`;
      }
      const r = await graphRequest(token, path);
      if (!r.ok) {
        throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
      }
      return mcpJsonResult(r.json);
    },
  );
}

const outlookMailReadArgs = z.object({
  messageId: z.string().min(1),
});

if (outlookToolShouldRegister("outlook_mail_read", grantedOutlookScopes)) {
  registerSimpleTool(
    "outlook_mail_read",
    "Read a single message (body, headers, attachments metadata).",
    outlookMailReadArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = outlookMailReadArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
      const r = await graphRequest(
        token,
        `/me/messages/${encodeURIComponent(parsed.data.messageId)}?$expand=attachments`,
      );
      if (!r.ok) {
        throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
      }
      return mcpJsonResult(r.json);
    },
  );
}

const outlookMailSendArgs = z.object({
  to: headerLine({ min: 1, max: 2000 }),
  subject: headerLine({ min: 1, max: 500 }),
  body: z.string().min(1).max(1_000_000),
  contentType: z.enum(["text", "html"]).optional(),
  cc: headerLine({ max: 2000 }).optional(),
});

if (outlookToolShouldRegister("outlook_mail_send", grantedOutlookScopes)) {
  registerSimpleTool(
    "outlook_mail_send",
    "Send an email via Microsoft Graph. Requires Gateway HITL email.send.",
    outlookMailSendArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = outlookMailSendArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
      const toList = parsed.data.to
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const message: Record<string, unknown> = {
        subject: parsed.data.subject,
        body: {
          contentType: (parsed.data.contentType ?? "text") === "html" ? "HTML" : "Text",
          content: parsed.data.body,
        },
        toRecipients: toList.map((addr) => ({
          emailAddress: { address: addr },
        })),
      };
      if (parsed.data.cc !== undefined && parsed.data.cc !== "") {
        const ccList = parsed.data.cc
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        message["ccRecipients"] = ccList.map((addr) => ({
          emailAddress: { address: addr },
        }));
      }
      const r = await graphRequest(token, "/me/sendMail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, saveToSentItems: true }),
      });
      if (!r.ok) {
        throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
      }
      return mcpJsonResult({ ok: true });
    },
  );
}

const outlookCalendarListArgs = z.object({
  startDateTime: z.string().min(1),
  endDateTime: z.string().min(1),
  top: z.number().int().min(1).max(200).optional(),
  nextLink: z.url().optional(),
});

if (outlookToolShouldRegister("outlook_calendar_list", grantedOutlookScopes)) {
  registerSimpleTool(
    "outlook_calendar_list",
    "List calendar events in a time window (ISO 8601 startDateTime / endDateTime).",
    outlookCalendarListArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = outlookCalendarListArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
      let path: string;
      if (parsed.data.nextLink !== undefined && parsed.data.nextLink !== "") {
        path = parsed.data.nextLink;
      } else {
        const top = parsed.data.top ?? 50;
        const s = encodeURIComponent(parsed.data.startDateTime);
        const e = encodeURIComponent(parsed.data.endDateTime);
        path = `/me/calendarView?startDateTime=${s}&endDateTime=${e}&$top=${String(top)}`;
      }
      const r = await graphRequest(token, path);
      if (!r.ok) {
        throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
      }
      return mcpJsonResult(r.json);
    },
  );
}

const outlookCalendarGetArgs = z.object({
  eventId: z.string().min(1),
});

if (outlookToolShouldRegister("outlook_calendar_get", grantedOutlookScopes)) {
  registerSimpleTool(
    "outlook_calendar_get",
    "Get a single calendar event by id.",
    outlookCalendarGetArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = outlookCalendarGetArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
      const r = await graphRequest(token, `/me/events/${encodeURIComponent(parsed.data.eventId)}`);
      if (!r.ok) {
        throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
      }
      return mcpJsonResult(r.json);
    },
  );
}

const outlookCalendarCreateArgs = z.object({
  subject: headerLine({ min: 1, max: 500 }),
  startDateTime: z.string().min(1),
  endDateTime: z.string().min(1),
  timeZone: z.string().min(1).max(100).optional(),
  body: z.string().max(50_000).optional(),
  attendees: headerLine({ max: 4000 }).optional(),
});

if (outlookToolShouldRegister("outlook_calendar_create", grantedOutlookScopes)) {
  registerSimpleTool(
    "outlook_calendar_create",
    "Create a calendar event. Requires Gateway HITL calendar.event.create.",
    outlookCalendarCreateArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = outlookCalendarCreateArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
      const tz = parsed.data.timeZone ?? "UTC";
      const body: Record<string, unknown> = {
        subject: parsed.data.subject,
        start: { dateTime: parsed.data.startDateTime, timeZone: tz },
        end: { dateTime: parsed.data.endDateTime, timeZone: tz },
      };
      if (parsed.data.body !== undefined && parsed.data.body !== "") {
        body["body"] = { contentType: "Text", content: parsed.data.body };
      }
      if (parsed.data.attendees !== undefined && parsed.data.attendees !== "") {
        const addrs = parsed.data.attendees
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        body["attendees"] = addrs.map((a) => ({
          emailAddress: { address: a },
          type: "required",
        }));
      }
      const r = await graphRequest(token, "/me/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
      }
      return mcpJsonResult(r.json);
    },
  );
}

const outlookCalendarDeleteArgs = z.object({
  eventId: z.string().min(1),
});

if (outlookToolShouldRegister("outlook_calendar_delete", grantedOutlookScopes)) {
  registerSimpleTool(
    "outlook_calendar_delete",
    "Delete a calendar event. Requires Gateway HITL calendar.event.delete.",
    outlookCalendarDeleteArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = outlookCalendarDeleteArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
      const r = await graphRequest(token, `/me/events/${encodeURIComponent(parsed.data.eventId)}`, {
        method: "DELETE",
      });
      if (!r.ok && r.status !== 204) {
        throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
      }
      return mcpJsonResult({ ok: true });
    },
  );
}

const outlookContactListArgs = z.object({
  top: z.number().int().min(1).max(200).optional(),
  skip: z.number().int().min(0).optional(),
  nextLink: z.url().optional(),
});

if (outlookToolShouldRegister("outlook_contact_list", grantedOutlookScopes)) {
  registerSimpleTool(
    "outlook_contact_list",
    "List contacts from the default folder.",
    outlookContactListArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = outlookContactListArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
      let path: string;
      if (parsed.data.nextLink !== undefined && parsed.data.nextLink !== "") {
        path = parsed.data.nextLink;
      } else {
        const top = parsed.data.top ?? 50;
        const skip = parsed.data.skip ?? 0;
        path = `/me/contacts?$top=${String(top)}&$skip=${String(skip)}`;
      }
      const r = await graphRequest(token, path);
      if (!r.ok) {
        throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
      }
      return mcpJsonResult(r.json);
    },
  );
}

const outlookContactGetArgs = z.object({
  contactId: z.string().min(1),
});

if (outlookToolShouldRegister("outlook_contact_get", grantedOutlookScopes)) {
  registerSimpleTool(
    "outlook_contact_get",
    "Get a single contact by id.",
    outlookContactGetArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = outlookContactGetArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
      const r = await graphRequest(
        token,
        `/me/contacts/${encodeURIComponent(parsed.data.contactId)}`,
      );
      if (!r.ok) {
        throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
      }
      return mcpJsonResult(r.json);
    },
  );
}

await server.connect(new StdioServerTransport());
