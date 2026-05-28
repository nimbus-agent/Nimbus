import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fetchBearerAuthorizedJson, resolveUrlWithBase } from "../../shared/fetch-bearer-json.ts";
import {
  createRegisterSimpleTool,
  type McpListResult,
  mcpJsonResult,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmailFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const url = resolveUrlWithBase(GMAIL_BASE, path);
  return fetchBearerAuthorizedJson(url, token, init);
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

const registerSimpleTool = createRegisterSimpleTool(server);

const gmailMessageListArgs = z.object({
  maxResults: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  q: z.string().max(500).optional(),
  labelIds: z.array(z.string()).optional(),
  includeSpamTrash: z.boolean().optional(),
});

registerSimpleTool(
  "gmail_message_list",
  "List Gmail message ids (metadata). Optional Gmail search query `q` (same syntax as Gmail UI).",
  gmailMessageListArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gmailMessageListArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const u = new URL(`${GMAIL_BASE}/messages`);
    u.searchParams.set("maxResults", String(parsed.data.maxResults ?? 25));
    if (parsed.data.pageToken !== undefined && parsed.data.pageToken !== "") {
      u.searchParams.set("pageToken", parsed.data.pageToken);
    }
    if (parsed.data.q !== undefined && parsed.data.q !== "") {
      u.searchParams.set("q", parsed.data.q);
    }
    if (parsed.data.labelIds !== undefined) {
      for (const lid of parsed.data.labelIds) {
        u.searchParams.append("labelIds", lid);
      }
    }
    if (parsed.data.includeSpamTrash === true) {
      u.searchParams.set("includeSpamTrash", "true");
    }
    const r = await gmailFetch(token, u.toString());
    if (!r.ok) {
      throw new Error(`Gmail API ${String(r.status)}: ${r.text.slice(0, 200)}`);
    }
    return mcpJsonResult(r.json);
  },
);

const gmailMessageReadArgs = z.object({
  messageId: z.string().min(1),
  format: z.enum(["minimal", "full", "metadata", "raw"]).optional(),
});

registerSimpleTool(
  "gmail_message_read",
  "Read a single Gmail message (format minimal | metadata | full | raw).",
  gmailMessageReadArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gmailMessageReadArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const fmt = parsed.data.format ?? "metadata";
    const u = new URL(`${GMAIL_BASE}/messages/${encodeURIComponent(parsed.data.messageId)}`);
    u.searchParams.set("format", fmt);
    if (fmt === "metadata") {
      u.searchParams.append("metadataHeaders", "Subject");
      u.searchParams.append("metadataHeaders", "From");
      u.searchParams.append("metadataHeaders", "To");
      u.searchParams.append("metadataHeaders", "Date");
    }
    const r = await gmailFetch(token, u.toString());
    if (!r.ok) {
      throw new Error(`Gmail API ${String(r.status)}: ${r.text.slice(0, 200)}`);
    }
    return mcpJsonResult(r.json);
  },
);

const gmailThreadReadArgs = z.object({
  threadId: z.string().min(1),
  format: z.enum(["minimal", "full", "metadata"]).optional(),
});

registerSimpleTool(
  "gmail_thread_read",
  "Read a Gmail thread and its messages.",
  gmailThreadReadArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gmailThreadReadArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const fmt = parsed.data.format ?? "metadata";
    const u = new URL(`${GMAIL_BASE}/threads/${encodeURIComponent(parsed.data.threadId)}`);
    u.searchParams.set("format", fmt);
    const r = await gmailFetch(token, u.toString());
    if (!r.ok) {
      throw new Error(`Gmail API ${String(r.status)}: ${r.text.slice(0, 200)}`);
    }
    return mcpJsonResult(r.json);
  },
);

const gmailLabelListArgs = z.object({});

registerSimpleTool(
  "gmail_label_list",
  "List all Gmail labels.",
  gmailLabelListArgs.shape,
  async (_args: unknown): Promise<McpListResult> => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const r = await gmailFetch(token, `${GMAIL_BASE}/labels`);
    if (!r.ok) {
      throw new Error(`Gmail API ${String(r.status)}: ${r.text.slice(0, 200)}`);
    }
    return mcpJsonResult(r.json);
  },
);

const gmailDraftCreateArgs = z.object({
  to: z.string().min(1),
  subject: z.string().min(1).max(998),
  body: z.string().max(1_000_000),
  cc: z.string().optional(),
  bcc: z.string().optional(),
});

registerSimpleTool(
  "gmail_draft_create",
  "Create a Gmail draft. Requires Gateway HITL email.draft.create.",
  gmailDraftCreateArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gmailDraftCreateArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const msgParams: { to: string; subject: string; body: string; cc?: string; bcc?: string } = {
      to: parsed.data.to,
      subject: parsed.data.subject,
      body: parsed.data.body,
    };
    if (parsed.data.cc !== undefined && parsed.data.cc !== "") {
      msgParams.cc = parsed.data.cc;
    }
    if (parsed.data.bcc !== undefined && parsed.data.bcc !== "") {
      msgParams.bcc = parsed.data.bcc;
    }
    const raw = toRawBase64Url(buildRfc822Message(msgParams));
    const r = await gmailFetch(token, `${GMAIL_BASE}/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw } }),
    });
    if (!r.ok) {
      throw new Error(`Gmail API ${String(r.status)}: ${r.text.slice(0, 200)}`);
    }
    return mcpJsonResult(r.json);
  },
);

const gmailDraftSendArgs = z.object({
  draftId: z.string().min(1),
});

registerSimpleTool(
  "gmail_draft_send",
  "Send an existing Gmail draft by id. Requires Gateway HITL email.draft.send.",
  gmailDraftSendArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gmailDraftSendArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const r = await gmailFetch(token, `${GMAIL_BASE}/drafts/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: parsed.data.draftId }),
    });
    if (!r.ok) {
      throw new Error(`Gmail API ${String(r.status)}: ${r.text.slice(0, 200)}`);
    }
    return mcpJsonResult(r.json);
  },
);

const gmailMessageSendArgs = z.object({
  to: z.string().min(1),
  subject: z.string().min(1).max(998),
  body: z.string().max(1_000_000),
  cc: z.string().optional(),
  bcc: z.string().optional(),
});

registerSimpleTool(
  "gmail_message_send",
  "Send a new Gmail message (not a draft). Requires Gateway HITL email.send.",
  gmailMessageSendArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gmailMessageSendArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const sendParams: { to: string; subject: string; body: string; cc?: string; bcc?: string } = {
      to: parsed.data.to,
      subject: parsed.data.subject,
      body: parsed.data.body,
    };
    if (parsed.data.cc !== undefined && parsed.data.cc !== "") {
      sendParams.cc = parsed.data.cc;
    }
    if (parsed.data.bcc !== undefined && parsed.data.bcc !== "") {
      sendParams.bcc = parsed.data.bcc;
    }
    const raw = toRawBase64Url(buildRfc822Message(sendParams));
    const r = await gmailFetch(token, `${GMAIL_BASE}/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!r.ok) {
      throw new Error(`Gmail API ${String(r.status)}: ${r.text.slice(0, 200)}`);
    }
    return mcpJsonResult(r.json);
  },
);

await server.connect(new StdioServerTransport());
