import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { headerLine } from "../../shared/header-safe.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResultIfOk,
  requireProcessEnv,
  type ZodObjectSchema,
} from "../../shared/mcp-tool-kit.ts";
import { makeRestFetcher, makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";

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

/** Standard Gmail tool: token → gmailFetch(buildPath[, buildInit]) → mcpJsonResultIfOk("Gmail API", …, 200). */
import { createWriteToolRegistrar, type WriteToolConfig } from "../../shared/consent-kit.ts";

/**
 * Every MUTATING gmail tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "gmail",
  scopeEnv: "NIMBUS_MCP_GMAIL_WRITE_SCOPE",
  scopeKinds: ["recipient", "draft"],
});

/**
 * The write-tool equivalent of `registerGmailTool`: identical fetch and result handling, routed
 * through the write registrar.
 */
function registerGmailWriteTool<T>(
  name: string,
  cfg: WriteToolConfig<T>,
  description: string,
  schema: ZodObjectSchema<T>,
  buildPath: (p: T) => string,
  buildInit?: (p: T) => RequestInit,
): void {
  registerWriteTool(name, cfg, description, schema, async (parsed) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const res = await gmailFetch(token, buildPath(parsed), buildInit?.(parsed));
    return mcpJsonResultIfOk("Gmail API", res, 200);
  });
}

const registerGmailTool = makeRestToolRegistrar({
  registrar: reg,
  tokenEnv: "GOOGLE_OAUTH_ACCESS_TOKEN",
  serviceLabel: "Gmail API",
  fetch: gmailFetch,
  snippetMax: 200,
});

const gmailMessageListArgs = z.object({
  maxResults: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  q: z.string().max(500).optional(),
  labelIds: z.array(z.string()).optional(),
  includeSpamTrash: z.boolean().optional(),
});

registerGmailTool(
  "gmail_message_list",
  "List Gmail message ids (metadata). Optional Gmail search query `q` (same syntax as Gmail UI).",
  gmailMessageListArgs,
  (data) => {
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
    return u.toString();
  },
);

const gmailMessageReadArgs = z.object({
  messageId: z.string().min(1),
  format: z.enum(["minimal", "full", "metadata", "raw"]).optional(),
});

registerGmailTool(
  "gmail_message_read",
  "Read a single Gmail message (format minimal | metadata | full | raw).",
  gmailMessageReadArgs,
  (data) => {
    const fmt = data.format ?? "metadata";
    const u = new URL(`${GMAIL_BASE}/messages/${encodeURIComponent(data.messageId)}`);
    u.searchParams.set("format", fmt);
    if (fmt === "metadata") {
      u.searchParams.append("metadataHeaders", "Subject");
      u.searchParams.append("metadataHeaders", "From");
      u.searchParams.append("metadataHeaders", "To");
      u.searchParams.append("metadataHeaders", "Date");
    }
    return u.toString();
  },
);

const gmailThreadReadArgs = z.object({
  threadId: z.string().min(1),
  format: z.enum(["minimal", "full", "metadata"]).optional(),
});

registerGmailTool(
  "gmail_thread_read",
  "Read a Gmail thread and its messages.",
  gmailThreadReadArgs,
  (data) => {
    const fmt = data.format ?? "metadata";
    const u = new URL(`${GMAIL_BASE}/threads/${encodeURIComponent(data.threadId)}`);
    u.searchParams.set("format", fmt);
    return u.toString();
  },
);

const gmailLabelListArgs = z.object({});

registerGmailTool(
  "gmail_label_list",
  "List all Gmail labels.",
  gmailLabelListArgs,
  () => `${GMAIL_BASE}/labels`,
);

const gmailDraftCreateArgs = z.object({
  to: headerLine({ min: 1 }),
  subject: headerLine({ min: 1, max: 998 }),
  body: z.string().max(1_000_000),
  cc: headerLine().optional(),
  bcc: headerLine().optional(),
});

registerGmailWriteTool(
  "gmail_draft_create",
  {
    mutates: "gmail.draft.create",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "recipient", value: p.to }),
  },
  "Create a Gmail draft. Requires Gateway HITL email.draft.create.",
  gmailDraftCreateArgs,
  () => `${GMAIL_BASE}/drafts`,
  (data) => {
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
    return {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw } }),
    };
  },
);

const gmailDraftSendArgs = z.object({
  draftId: z.string().min(1),
});

registerGmailWriteTool(
  "gmail_draft_send",
  {
    mutates: "gmail.draft.send",
    recoverable: false,
    capturePreState: (p) => Promise.resolve({ draftId: p.draftId }),
    scopeTargetOf: (p) => ({ kind: "draft", value: p.draftId }),
  },
  "Send an existing Gmail draft by id. Requires Gateway HITL email.draft.send.",
  gmailDraftSendArgs,
  () => `${GMAIL_BASE}/drafts/send`,
  (data) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: data.draftId }),
  }),
);

const gmailMessageSendArgs = z.object({
  to: headerLine({ min: 1 }),
  subject: headerLine({ min: 1, max: 998 }),
  body: z.string().max(1_000_000),
  cc: headerLine().optional(),
  bcc: headerLine().optional(),
});

registerGmailWriteTool(
  "gmail_message_send",
  {
    mutates: "gmail.message.send",
    recoverable: false,
    // A sent mail cannot be recalled and nothing remains to query, so the recipient and subject
    // ARE the pre-state.
    capturePreState: (p) => Promise.resolve({ to: p.to, subject: p.subject }),
    scopeTargetOf: (p) => ({ kind: "recipient", value: p.to }),
  },
  "Send a new Gmail message (not a draft). Requires Gateway HITL email.send.",
  gmailMessageSendArgs,
  () => `${GMAIL_BASE}/messages/send`,
  (data) => {
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
    return {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    };
  },
);

await server.connect(new StdioServerTransport());
