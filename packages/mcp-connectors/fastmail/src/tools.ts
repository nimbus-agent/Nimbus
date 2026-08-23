import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../shared/consent-kit.ts";

import { emailToolSchemas } from "../../shared/imap-tool-kit.ts";
import {
  createRegisterSimpleTool,
  type McpListResult,
  mcpJsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { clampLimit, type JmapClient, type JmapEmailView } from "./jmap-core.ts";

/** A JMAP email view is already the JSON-safe header/metadata/preview shape. */
function viewToJson(v: JmapEmailView): Record<string, unknown> {
  return {
    id: v.id,
    messageId: v.messageId,
    subject: v.subject,
    from: [...v.from],
    to: [...v.to],
    cc: [...v.cc],
    receivedAt: v.receivedAt,
    attachments: v.attachments.map((a) => ({
      filename: a.name,
      sizeBytes: a.sizeBytes,
      mimeType: a.mimeType,
    })),
    preview: v.preview,
  };
}

const listArgs = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

const getArgs = z.object({
  id: z.string().min(1),
});

const searchArgs = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(200).optional(),
});

/**
 * Register the Fastmail JMAP read tools + the HITL-gated send tool onto an MCP
 * server. The JMAP client is injected so tests exercise the tool surface without
 * opening a real socket.
 */
export function registerFastmailTools(
  // Widened from `{ tool: ... }`: the consent kit needs the real server surface — capabilities,
  // registerTool, list-changed and logging — not just the deprecated `.tool` shim.
  server: ConsentServer & { tool: (...args: never) => unknown },
  client: JmapClient,
): void {
  const registerSimpleTool = createRegisterSimpleTool(server);
  const { sendArgs } = emailToolSchemas;

  registerSimpleTool(
    "fastmail_list",
    "List recent mailbox emails — HEADERS + attachment METADATA + a short capped text preview ONLY. Returns subject, from, to/cc, received date, message-id, attachment {filename,size,mimetype}, and a <=2000-char plain-text body preview. NEVER returns attachment bytes or the full message body.",
    listArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = listArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const items = await client.list(clampLimit(parsed.data.limit));
      return mcpJsonResult({ items: items.map(viewToJson) });
    },
  );

  registerSimpleTool(
    "fastmail_get",
    "Fetch one email by JMAP id — HEADERS + attachment METADATA + a short capped text preview ONLY. NEVER returns attachment bytes or the full message body.",
    getArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = getArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const v = await client.get(parsed.data.id);
      return mcpJsonResult(v === null ? { item: null } : { item: viewToJson(v) });
    },
  );

  registerSimpleTool(
    "fastmail_search",
    "Full-text search over emails (JMAP Email/query text filter) — returns the same header + attachment-metadata + preview view as fastmail_list. NEVER returns attachment bytes or the full message body beyond the capped preview.",
    searchArgs.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = searchArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const items = await client.search(parsed.data.query, clampLimit(parsed.data.limit));
      return mcpJsonResult({ matches: items.map(viewToJson) });
    },
  );

  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "fastmail",
    scopeEnv: "NIMBUS_MCP_FASTMAIL_WRITE_SCOPE",
    scopeKinds: ["recipient"],
  });

  registerWriteTool(
    "fastmail_mail_send",
    {
      mutates: "fastmail.mail.send",
      // A sent mail cannot be recalled and nothing remains to query, so the recipient and
      // subject ARE the pre-state.
      recoverable: false,
      capturePreState: (p) => Promise.resolve({ to: p.to, subject: p.subject }),
      scopeTargetOf: (p) => ({ kind: "recipient", value: p.to }),
    },
    "Send a new email via JMAP EmailSubmission.",
    sendArgs,
    async (parsedData): Promise<McpListResult> => {
      const parsed = { success: true as const, data: parsedData };
      const input: { to: string; subject: string; body: string; cc?: string; bcc?: string } = {
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
      const res = await client.send(input);
      return mcpJsonResult({ emailId: res.emailId, submissionId: res.submissionId });
    },
  );
}

/** Tool names exposed by this connector — for contract/introspection tests. */
export const FASTMAIL_TOOL_NAMES = [
  "fastmail_list",
  "fastmail_get",
  "fastmail_search",
  "fastmail_mail_send",
] as const;
