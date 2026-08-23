import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { McpListResult } from "../../shared/mcp-tool-kit.ts";
import type {
  ImapClient,
  ImapListOptions,
  ImapMessageMeta,
  ImapSearchOptions,
  SendMailInput,
  SendMailResult,
  SmtpMailer,
} from "../src/imap-core.ts";
import { IMAP_TOOL_NAMES, registerImapTools } from "../src/tools.ts";

// These cases exercise the TOOL SURFACE, not the consent gate, and pass a minimal fake server.
// Gateway mode is the shape they were written against: the connector registers everything and
// executor.ts (I2) is the gate there. Reset on BOTH sides — bun test runs many files in ONE
// process, so an unreset lock would change every file that runs after this one.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
});
afterEach(() => {
  resetConnectorModeForTests();
});

type Handler = (args: unknown) => Promise<McpListResult>;

function fakeServer() {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _desc: string, _shape: unknown, handler: Handler): void => {
      handlers.set(name, handler);
    },

    // The consent kit registers through `registerTool`, which returns a handle; the deprecated
    // `tool` above is what the read tools still use. Both record into the same map.
    registerTool: (name: string, _cfg: unknown, handler: Handler): { disable: () => void } => {
      handlers.set(name, handler);
      return { disable: () => undefined };
    },
  };
  return { server, handlers };
}

function sampleMessage(): ImapMessageMeta {
  return {
    uid: 9,
    mailbox: "INBOX",
    uidValidity: "100",
    envelope: {
      date: new Date("2026-05-31T00:00:00.000Z"),
      subject: "Hello",
      messageId: "<a@x>",
      from: [{ name: "Ada", address: "ada@x.com" }],
      to: [{ address: "team@x.com" }],
      cc: [],
    },
    attachments: [{ filename: "secret.pdf", sizeBytes: 1234, mimeType: "application/pdf" }],
    preview: "the body preview",
  };
}

class FakeClient implements ImapClient {
  public lastList: ImapListOptions | null = null;
  public lastSearch: ImapSearchOptions | null = null;
  public lastGetUid = 0;
  async list(options: ImapListOptions): Promise<ImapMessageMeta[]> {
    this.lastList = options;
    return [sampleMessage()];
  }
  async get(uid: number): Promise<ImapMessageMeta | null> {
    this.lastGetUid = uid;
    return uid === 9 ? sampleMessage() : null;
  }
  async search(options: ImapSearchOptions): Promise<ImapMessageMeta[]> {
    this.lastSearch = options;
    return [sampleMessage()];
  }
}

class FakeMailer implements SmtpMailer {
  public lastInput: SendMailInput | null = null;
  async send(input: SendMailInput): Promise<SendMailResult> {
    this.lastInput = input;
    return { messageId: "<sent@x>", accepted: [input.to], rejected: [] };
  }
}

function parse(result: McpListResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function wire() {
  const { server, handlers } = fakeServer();
  const client = new FakeClient();
  const mailer = new FakeMailer();
  registerImapTools(server, client, mailer);
  return { handlers, client, mailer };
}

describe("registerImapTools", () => {
  test("registers exactly the documented tool surface", () => {
    const { handlers } = wire();
    expect([...handlers.keys()].sort((a, b) => a.localeCompare(b))).toEqual(
      [...IMAP_TOOL_NAMES].sort((a, b) => a.localeCompare(b)),
    );
  });

  test("imap_list returns the header/metadata/preview view — never attachment bytes", async () => {
    const { handlers } = wire();
    const out = parse(await handlers.get("imap_list")!({ limit: 10 }));
    const items = out.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const m = items[0]!;
    expect(m.subject).toBe("Hello");
    expect(m.from).toEqual(["Ada <ada@x.com>"]);
    expect(m.preview).toBe("the body preview");
    const att = (m.attachments as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(att).sort((a, b) => a.localeCompare(b))).toEqual([
      "filename",
      "mimeType",
      "sizeBytes",
    ]);
    // No content/data/base64 field anywhere in the serialized view.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('"content"');
    expect(serialized).not.toContain("base64");
  });

  test("imap_get fetches by uid and returns null for an unknown uid", async () => {
    const { handlers, client } = wire();
    const hit = parse(await handlers.get("imap_get")!({ uid: 9 }));
    expect((hit.item as Record<string, unknown>).uid).toBe(9);
    expect(client.lastGetUid).toBe(9);
    const miss = parse(await handlers.get("imap_get")!({ uid: 404 }));
    expect(miss.item).toBeNull();
  });

  test("imap_search passes the query through and returns matches", async () => {
    const { handlers, client } = wire();
    const out = parse(await handlers.get("imap_search")!({ query: "hello", limit: 5 }));
    expect(out.matches as unknown[]).toHaveLength(1);
    expect(client.lastSearch?.query).toBe("hello");
  });

  test("imap_mail_send delegates to the SMTP mailer and returns the send result", async () => {
    const { handlers, mailer } = wire();
    const out = parse(
      await handlers.get("imap_mail_send")!({
        to: "dest@x.com",
        subject: "Hi",
        body: "Body text",
        cc: "c@x.com",
      }),
    );
    expect(mailer.lastInput).toEqual({
      to: "dest@x.com",
      subject: "Hi",
      body: "Body text",
      cc: "c@x.com",
    });
    expect(out.messageId).toBe("<sent@x>");
    expect(out.accepted).toEqual(["dest@x.com"]);
  });

  test("rejects invalid args (empty subject)", async () => {
    const { handlers } = wire();
    await expect(
      handlers.get("imap_mail_send")!({ to: "x@x.com", subject: "", body: "b" }),
    ).rejects.toThrow();
  });
});
