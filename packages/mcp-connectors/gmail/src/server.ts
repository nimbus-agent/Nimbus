import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResultIfOk,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";
import { makeRestFetcher } from "../../shared/rest-tool-kit.ts";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function gmailFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  return makeRestFetcher({ apiBase: GMAIL_BASE, token })(path, init);
}

function buildRfc822Message(params: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): string {
  const lines: string[] = [
    `To: ${params.to}`,
    ...(params.cc !== undefined && params.cc !== "" ? [`Cc: ${params.cc}`] : []),
    ...(params.bcc !== undefined && params.bcc !== "" ? [`Bcc: ${params.bcc}`] : []),
    `Subject: ${params.subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    params.body,
  ];
  return lines.join("\r\n");
}

function toRawBase64Url(rfc822: string): string {
  return Buffer.from(rfc822, "utf-8").toString("base64url");
}

const server = new McpServer({ name: "nimbus-gmail", version: "0.1.0" });

const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

const gmailMessageListArgs = z.object({
  maxResults: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  q: z.string().max(500).optional(),
  labelIds: z.array(z.string()).optional(),
  includeSpamTrash: z.boolean().optional(),
});

reg(
  "gmail_message_list",
  "List Gmail message ids (metadata). Optional Gmail search query `q` (same syntax as Gmail UI).",
  gmailMessageListArgs,
  async (data) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const u = new URL(`${GMAIL_BASE}/messages`);
    u.searchParams.set("maxResults", String(data.maxResults ?? 25));
    if (data.pageToken !== undefined && data.pageToken !== "") {
      u.searchParams.set("pageToken", data.pageToken);
    }
    if (data.q !== undefined && data.q !== "") {
      u.searchParams.set("q", data.q);
    }
    if (data.labelIds !== undefined) {
      for (const lid of data.labelIds) {
        u.searchParams.append("labelIds", lid);
      }
    }
    if (data.includeSpamTrash === true) {
      u.searchParams.set("includeSpamTrash", "true");
    }
    return mcpJsonResultIfOk("Gmail API", await gmailFetch(token, u.toString()), 200);
  },
);

const gmailMessageReadArgs = z.object({
  messageId: z.string().min(1),
  format: z.enum(["minimal", "full", "metadata", "raw"]).optional(),
});

reg(
  "gmail_message_read",
  "Read a single Gmail message (format minimal | metadata | full | raw).",
  gmailMessageReadArgs,
  async (data) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const fmt = data.format ?? "metadata";
    const u = new URL(`${GMAIL_BASE}/messages/${encodeURIComponent(data.messageId)}`);
    u.searchParams.set("format", fmt);
    if (fmt === "metadata") {
      u.searchParams.append("metadataHeaders", "Subject");
      u.searchParams.append("metadataHeaders", "From");
      u.searchParams.append("metadataHeaders", "To");
      u.searchParams.append("metadataHeaders", "Date");
    }
    return mcpJsonResultIfOk("Gmail API", await gmailFetch(token, u.toString()), 200);
  },
);

const gmailThreadReadArgs = z.object({
  threadId: z.string().min(1),
  format: z.enum(["minimal", "full", "metadata"]).optional(),
});

reg(
  "gmail_thread_read",
  "Read a Gmail thread and its messages.",
  gmailThreadReadArgs,
  async (data) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const fmt = data.format ?? "metadata";
    const u = new URL(`${GMAIL_BASE}/threads/${encodeURIComponent(data.threadId)}`);
    u.searchParams.set("format", fmt);
    return mcpJsonResultIfOk("Gmail API", await gmailFetch(token, u.toString()), 200);
  },
);

const gmailLabelListArgs = z.object({});

reg("gmail_label_list", "List all Gmail labels.", gmailLabelListArgs, async () => {
  const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
  return mcpJsonResultIfOk("Gmail API", await gmailFetch(token, `${GMAIL_BASE}/labels`), 200);
});

const gmailDraftCreateArgs = z.object({
  to: z.string().min(1),
  subject: z.string().min(1).max(998),
  body: z.string().max(1_000_000),
  cc: z.string().optional(),
  bcc: z.string().optional(),
});

reg(
  "gmail_draft_create",
  "Create a Gmail draft. Requires Gateway HITL email.draft.create.",
  gmailDraftCreateArgs,
  async (data) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const msgParams: { to: string; subject: string; body: string; cc?: string; bcc?: string } = {
      to: data.to,
      subject: data.subject,
      body: data.body,
    };
    if (data.cc !== undefined && data.cc !== "") {
      msgParams.cc = data.cc;
    }
    if (data.bcc !== undefined && data.bcc !== "") {
      msgParams.bcc = data.bcc;
    }
    const raw = toRawBase64Url(buildRfc822Message(msgParams));
    const r = await gmailFetch(token, `${GMAIL_BASE}/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw } }),
    });
    return mcpJsonResultIfOk("Gmail API", r, 200);
  },
);

const gmailDraftSendArgs = z.object({
  draftId: z.string().min(1),
});

reg(
  "gmail_draft_send",
  "Send an existing Gmail draft by id. Requires Gateway HITL email.draft.send.",
  gmailDraftSendArgs,
  async (data) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const r = await gmailFetch(token, `${GMAIL_BASE}/drafts/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: data.draftId }),
    });
    return mcpJsonResultIfOk("Gmail API", r, 200);
  },
);

const gmailMessageSendArgs = z.object({
  to: z.string().min(1),
  subject: z.string().min(1).max(998),
  body: z.string().max(1_000_000),
  cc: z.string().optional(),
  bcc: z.string().optional(),
});

reg(
  "gmail_message_send",
  "Send a new Gmail message (not a draft). Requires Gateway HITL email.send.",
  gmailMessageSendArgs,
  async (data) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const sendParams: { to: string; subject: string; body: string; cc?: string; bcc?: string } = {
      to: data.to,
      subject: data.subject,
      body: data.body,
    };
    if (data.cc !== undefined && data.cc !== "") {
      sendParams.cc = data.cc;
    }
    if (data.bcc !== undefined && data.bcc !== "") {
      sendParams.bcc = data.bcc;
    }
    const raw = toRawBase64Url(buildRfc822Message(sendParams));
    const r = await gmailFetch(token, `${GMAIL_BASE}/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    return mcpJsonResultIfOk("Gmail API", r, 200);
  },
);

await server.connect(new StdioServerTransport());
