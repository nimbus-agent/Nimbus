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
  createZodToolRegistrar,
  mcpJsonResult,
  mcpJsonResultIfOk,
  requireProcessEnv,
  type ZodObjectSchema,
} from "../../shared/mcp-tool-kit.ts";
import { makeRestFetcher, makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";
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

const reg = createZodToolRegistrar(createRegisterSimpleTool(server));
const grantedOutlookScopes = parseMicrosoftOAuthScopesFromEnv();

/** Standard Graph read tool: token → graphRequest(buildPath[, buildInit]) → mcpJsonResultIfOk("Graph", …, 200). */
import { createWriteToolRegistrar, type WriteToolConfig } from "../../shared/consent-kit.ts";

/**
 * Every MUTATING outlook tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "outlook",
  scopeEnv: "NIMBUS_MCP_OUTLOOK_WRITE_SCOPE",
  scopeKinds: ["recipient", "calendar"],
});

/**
 * The write-tool equivalent of `registerOutlookTool`: identical fetch and result handling, routed
 * through the write registrar.
 */
function registerOutlookWriteTool<T>(
  name: string,
  cfg: WriteToolConfig<T>,
  description: string,
  schema: ZodObjectSchema<T>,
  buildPath: (p: T) => string,
  buildInit?: (p: T) => RequestInit,
): void {
  registerWriteTool(name, cfg, description, schema, async (parsed) => {
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const res = await graphRequest(token, buildPath(parsed), buildInit?.(parsed));
    return mcpJsonResultIfOk("Graph", res, 200);
  });
}

const registerOutlookTool = makeRestToolRegistrar({
  registrar: reg,
  tokenEnv: "MICROSOFT_OAUTH_ACCESS_TOKEN",
  serviceLabel: "Graph",
  fetch: graphRequest,
  snippetMax: 200,
});

const outlookMailFoldersArgs = z.object({
  top: z.number().int().min(1).max(200).optional(),
  nextLink: z.url().optional(),
});

if (outlookToolShouldRegister("outlook_mail_folders", grantedOutlookScopes)) {
  registerOutlookTool(
    "outlook_mail_folders",
    "List mail folders (pagination via nextLink).",
    outlookMailFoldersArgs,
    (data) => {
      if (data.nextLink !== undefined && data.nextLink !== "") {
        return data.nextLink;
      }
      const top = data.top ?? 50;
      return `/me/mailFolders?$top=${String(top)}`;
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
  registerOutlookTool(
    "outlook_mail_list",
    "List mail messages (default folder inbox if folderId omitted). Pagination via nextLink.",
    outlookMailListArgs,
    (data) => {
      if (data.nextLink !== undefined && data.nextLink !== "") {
        return data.nextLink;
      }
      const top = data.top ?? 25;
      const fid = data.folderId !== undefined && data.folderId !== "" ? data.folderId : "inbox";
      const skip = data.skip ?? 0;
      const u = new URL(`${GRAPH}/me/mailFolders/${encodeURIComponent(fid)}/messages`);
      u.searchParams.set("$top", String(top));
      u.searchParams.set("$skip", String(skip));
      u.searchParams.set(
        "$select",
        "id,subject,bodyPreview,receivedDateTime,lastModifiedDateTime,hasAttachments,webLink",
      );
      if (data.filter !== undefined && data.filter !== "") {
        u.searchParams.set("$filter", data.filter);
      }
      return `${u.pathname}${u.search}`;
    },
  );
}

const outlookMailReadArgs = z.object({
  messageId: z.string().min(1),
});

if (outlookToolShouldRegister("outlook_mail_read", grantedOutlookScopes)) {
  registerOutlookTool(
    "outlook_mail_read",
    "Read a single message (body, headers, attachments metadata).",
    outlookMailReadArgs,
    (data) => `/me/messages/${encodeURIComponent(data.messageId)}?$expand=attachments`,
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
  registerWriteTool(
    "outlook_mail_send",
    {
      mutates: "outlook.mail.send",
      recoverable: false,
      capturePreState: (p) => Promise.resolve({ to: p.to, subject: p.subject }),
      scopeTargetOf: (p) => ({ kind: "recipient", value: p.to }),
    },
    "Send an email via Microsoft Graph. Requires Gateway HITL email.send.",
    outlookMailSendArgs,
    async (data) => {
      const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
      const toList = data.to
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const message: Record<string, unknown> = {
        subject: data.subject,
        body: {
          contentType: (data.contentType ?? "text") === "html" ? "HTML" : "Text",
          content: data.body,
        },
        toRecipients: toList.map((addr) => ({
          emailAddress: { address: addr },
        })),
      };
      if (data.cc !== undefined && data.cc !== "") {
        const ccList = data.cc
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
  registerOutlookTool(
    "outlook_calendar_list",
    "List calendar events in a time window (ISO 8601 startDateTime / endDateTime).",
    outlookCalendarListArgs,
    (data) => {
      if (data.nextLink !== undefined && data.nextLink !== "") {
        return data.nextLink;
      }
      const top = data.top ?? 50;
      const s = encodeURIComponent(data.startDateTime);
      const e = encodeURIComponent(data.endDateTime);
      return `/me/calendarView?startDateTime=${s}&endDateTime=${e}&$top=${String(top)}`;
    },
  );
}

const outlookCalendarGetArgs = z.object({
  eventId: z.string().min(1),
});

if (outlookToolShouldRegister("outlook_calendar_get", grantedOutlookScopes)) {
  registerOutlookTool(
    "outlook_calendar_get",
    "Get a single calendar event by id.",
    outlookCalendarGetArgs,
    (data) => `/me/events/${encodeURIComponent(data.eventId)}`,
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
  registerOutlookWriteTool(
    "outlook_calendar_create",
    {
      mutates: "outlook.calendar.create",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "calendar", value: p.subject }),
    },
    "Create a calendar event. Requires Gateway HITL calendar.event.create.",
    outlookCalendarCreateArgs,
    () => "/me/events",
    (data) => {
      const tz = data.timeZone ?? "UTC";
      const body: Record<string, unknown> = {
        subject: data.subject,
        start: { dateTime: data.startDateTime, timeZone: tz },
        end: { dateTime: data.endDateTime, timeZone: tz },
      };
      if (data.body !== undefined && data.body !== "") {
        body["body"] = { contentType: "Text", content: data.body };
      }
      if (data.attendees !== undefined && data.attendees !== "") {
        const addrs = data.attendees
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        body["attendees"] = addrs.map((a) => ({
          emailAddress: { address: a },
          type: "required",
        }));
      }
      return {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      };
    },
  );
}

const outlookCalendarDeleteArgs = z.object({
  eventId: z.string().min(1),
});

if (outlookToolShouldRegister("outlook_calendar_delete", grantedOutlookScopes)) {
  registerWriteTool(
    "outlook_calendar_delete",
    {
      mutates: "outlook.calendar.delete",
      recoverable: false,
      capturePreState: (p) => Promise.resolve({ eventId: p.eventId }),
      scopeTargetOf: (p) => ({ kind: "calendar", value: p.eventId }),
    },
    "Delete a calendar event. Requires Gateway HITL calendar.event.delete.",
    outlookCalendarDeleteArgs,
    async (data) => {
      const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
      const r = await graphRequest(token, `/me/events/${encodeURIComponent(data.eventId)}`, {
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
  registerOutlookTool(
    "outlook_contact_list",
    "List contacts from the default folder.",
    outlookContactListArgs,
    (data) => {
      if (data.nextLink !== undefined && data.nextLink !== "") {
        return data.nextLink;
      }
      const top = data.top ?? 50;
      const skip = data.skip ?? 0;
      return `/me/contacts?$top=${String(top)}&$skip=${String(skip)}`;
    },
  );
}

const outlookContactGetArgs = z.object({
  contactId: z.string().min(1),
});

if (outlookToolShouldRegister("outlook_contact_get", grantedOutlookScopes)) {
  registerOutlookTool(
    "outlook_contact_get",
    "Get a single contact by id.",
    outlookContactGetArgs,
    (data) => `/me/contacts/${encodeURIComponent(data.contactId)}`,
  );
}

await server.connect(new StdioServerTransport());
