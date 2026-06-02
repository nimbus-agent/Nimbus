import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { requireProcessEnv } from "../../shared/mcp-tool-kit.ts";
import {
  asRecord,
  asString,
  buildGetRequest,
  buildListRequest,
  buildSearchRequest,
  CORE_CAPABILITY,
  extractEmailList,
  type JmapClient,
  type JmapEmailView,
  type JmapSession,
  MAIL_CAPABILITY,
  methodResponseArgs,
  parseSession,
  type SendMailInput,
  type SendMailResult,
  SUBMISSION_CAPABILITY,
  viewEmail,
} from "./jmap-core.ts";
import { registerFastmailTools } from "./tools.ts";

const DEFAULT_BASE_URL = "https://api.fastmail.com";

/** Parse a comma-separated address list (`Name <a@x>, b@y`) → JMAP address objects. */
function parseAddressList(raw: string): Array<{ email: string }> {
  return raw
    .split(",")
    .map((part) => {
      const angle = /<([^>]+)>/.exec(part);
      const email = (angle?.[1] ?? part).trim();
      return email;
    })
    .filter((email) => email !== "")
    .map((email) => ({ email }));
}

/** Real Fastmail JMAP client over fetch. Discovers the session once, then reuses it. */
class FetchJmapClient implements JmapClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private session: JmapSession | null = null;

  constructor() {
    this.token = requireProcessEnv("FASTMAIL_API_TOKEN");
    const base = process.env["FASTMAIL_BASE_URL"]?.trim();
    this.baseUrl = (base === undefined || base === "" ? DEFAULT_BASE_URL : base).replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async ensureSession(): Promise<JmapSession> {
    if (this.session !== null) {
      return this.session;
    }
    const res = await fetch(`${this.baseUrl}/jmap/session`, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`JMAP session failed: HTTP ${String(res.status)}`);
    }
    const session = parseSession(await res.json());
    if (session === null) {
      throw new Error("JMAP session response missing apiUrl / mail account");
    }
    this.session = session;
    return session;
  }

  private async api(body: unknown): Promise<unknown> {
    const session = await this.ensureSession();
    const res = await fetch(session.apiUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`JMAP api failed: HTTP ${String(res.status)}`);
    }
    return res.json();
  }

  private async views(request: unknown): Promise<JmapEmailView[]> {
    const out: JmapEmailView[] = [];
    for (const raw of extractEmailList(await this.api(request))) {
      const v = viewEmail(raw);
      if (v !== null) {
        out.push(v);
      }
    }
    return out;
  }

  async list(limit: number): Promise<JmapEmailView[]> {
    const session = await this.ensureSession();
    return this.views(buildListRequest(session.accountId, limit));
  }

  async search(query: string, limit: number): Promise<JmapEmailView[]> {
    const session = await this.ensureSession();
    return this.views(buildSearchRequest(session.accountId, query, limit));
  }

  async get(id: string): Promise<JmapEmailView | null> {
    const session = await this.ensureSession();
    const views = await this.views(buildGetRequest(session.accountId, id));
    return views[0] ?? null;
  }

  async send(input: SendMailInput): Promise<SendMailResult> {
    const session = await this.ensureSession();
    const { accountId } = session;

    // Round 1: discover the sending identity + the Drafts mailbox.
    const discovery = await this.api({
      using: [CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY],
      methodCalls: [
        ["Identity/get", { accountId, ids: null }, "id"],
        ["Mailbox/query", { accountId, filter: { role: "drafts" } }, "mq"],
      ],
    });
    const identities = methodResponseArgs(discovery, "Identity/get")?.["list"];
    const identity = Array.isArray(identities) ? asRecord(identities[0]) : null;
    const identityId = identity === null ? null : asString(identity["id"]);
    const identityEmail = identity === null ? null : asString(identity["email"]);
    const mqIds = methodResponseArgs(discovery, "Mailbox/query")?.["ids"];
    const draftMailboxId = Array.isArray(mqIds) ? asString(mqIds[0]) : null;
    if (identityId === null || identityEmail === null || draftMailboxId === null) {
      throw new Error("JMAP send: could not resolve sending identity or Drafts mailbox");
    }

    // Round 2: create the draft email + submit it.
    const created = await this.api({
      using: [CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY],
      methodCalls: [
        [
          "Email/set",
          {
            accountId,
            create: {
              draft: {
                mailboxIds: { [draftMailboxId]: true },
                keywords: { $draft: true, $seen: true },
                from: [{ email: identityEmail }],
                to: parseAddressList(input.to),
                ...(input.cc !== undefined ? { cc: parseAddressList(input.cc) } : {}),
                ...(input.bcc !== undefined ? { bcc: parseAddressList(input.bcc) } : {}),
                subject: input.subject,
                bodyStructure: { type: "text/plain", partId: "b" },
                bodyValues: { b: { value: input.body } },
              },
            },
          },
          "es",
        ],
        [
          "EmailSubmission/set",
          {
            accountId,
            create: { sub: { emailId: "#draft", identityId } },
          },
          "sub",
        ],
      ],
    });
    const emailCreated = asRecord(methodResponseArgs(created, "Email/set")?.["created"]);
    const emailId =
      emailCreated === null ? null : asString(asRecord(emailCreated["draft"])?.["id"]);
    const subCreated = asRecord(methodResponseArgs(created, "EmailSubmission/set")?.["created"]);
    const submissionId = subCreated === null ? null : asString(asRecord(subCreated["sub"])?.["id"]);
    return { emailId, submissionId };
  }
}

const server = new McpServer({ name: "nimbus-fastmail", version: "0.1.0" });
registerFastmailTools(
  server as unknown as { tool: (...args: never) => unknown },
  new FetchJmapClient(),
);

await server.connect(new StdioServerTransport());
