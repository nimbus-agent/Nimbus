import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { McpListResult } from "../../shared/mcp-tool-kit.ts";
import type {
  MailClient,
  MailListOptions,
  MailMessageMeta,
  MailSearchOptions,
  SendMailInput,
  SendMailResult,
  SmtpMailer,
} from "../src/mail-core.ts";
import { PROTONMAIL_TOOL_NAMES, registerProtonmailTools } from "../src/tools.ts";

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

function sampleMessage(): MailMessageMeta {
  return {
    uid: 9,
    mailbox: "INBOX",
    uidValidity: "100",
    envelope: {
      date: new Date("2026-05-31T00:00:00.000Z"),
      subject: "Hello",
      messageId: "<a@proton.me>",
      from: [{ name: "Ada", address: "ada@proton.me" }],
      to: [{ address: "team@proton.me" }],
      cc: [],
    },
    attachments: [{ filename: "secret.pdf", sizeBytes: 1234, mimeType: "application/pdf" }],
    preview: "the body preview",
  };
}

class FakeClient implements MailClient {
  public lastSearch: MailSearchOptions | null = null;
  public lastGetUid = 0;
  async list(_options: MailListOptions): Promise<MailMessageMeta[]> {
    return [sampleMessage()];
  }
  async get(uid: number): Promise<MailMessageMeta | null> {
    this.lastGetUid = uid;
    return uid === 9 ? sampleMessage() : null;
  }
  async search(options: MailSearchOptions): Promise<MailMessageMeta[]> {
    this.lastSearch = options;
    return [sampleMessage()];
  }
}

class FakeMailer implements SmtpMailer {
  public lastInput: SendMailInput | null = null;
  async send(input: SendMailInput): Promise<SendMailResult> {
    this.lastInput = input;
    return { messageId: "<sent@proton.me>", accepted: [input.to], rejected: [] };
  }
}

function parse(result: McpListResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function wire() {
  const { server, handlers } = fakeServer();
  const client = new FakeClient();
  const mailer = new FakeMailer();
  registerProtonmailTools(server, client, mailer);
  return { handlers, client, mailer };
}

describe("registerProtonmailTools", () => {
  test("registers exactly the documented tool surface", () => {
    const { handlers } = wire();
    expect([...handlers.keys()].sort((a, b) => a.localeCompare(b))).toEqual(
      [...PROTONMAIL_TOOL_NAMES].sort((a, b) => a.localeCompare(b)),
    );
  });

  test("protonmail_list returns the header/metadata/preview view — never attachment bytes", async () => {
    const { handlers } = wire();
    const out = parse(await handlers.get("protonmail_list")!({ limit: 10 }));
    const items = out.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const m = items[0]!;
    expect(m.subject).toBe("Hello");
    expect(m.from).toEqual(["Ada <ada@proton.me>"]);
    const att = (m.attachments as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(att).sort((a, b) => a.localeCompare(b))).toEqual([
      "filename",
      "mimeType",
      "sizeBytes",
    ]);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('"content"');
    expect(serialized).not.toContain("base64");
  });

  test("protonmail_get fetches by uid and returns null for an unknown uid", async () => {
    const { handlers, client } = wire();
    const hit = parse(await handlers.get("protonmail_get")!({ uid: 9 }));
    expect((hit.item as Record<string, unknown>).uid).toBe(9);
    expect(client.lastGetUid).toBe(9);
    const miss = parse(await handlers.get("protonmail_get")!({ uid: 404 }));
    expect(miss.item).toBeNull();
  });

  test("protonmail_search passes the query through", async () => {
    const { handlers, client } = wire();
    const out = parse(await handlers.get("protonmail_search")!({ query: "hello", limit: 5 }));
    expect(out.matches as unknown[]).toHaveLength(1);
    expect(client.lastSearch?.query).toBe("hello");
  });

  test("protonmail_mail_send delegates to the Bridge SMTP mailer", async () => {
    const { handlers, mailer } = wire();
    const out = parse(
      await handlers.get("protonmail_mail_send")!({
        to: "dest@x.com",
        subject: "Hi",
        body: "Body text",
      }),
    );
    expect(mailer.lastInput).toEqual({ to: "dest@x.com", subject: "Hi", body: "Body text" });
    expect(out.messageId).toBe("<sent@proton.me>");
    expect(out.accepted).toEqual(["dest@x.com"]);
  });

  test("rejects invalid args (empty subject)", async () => {
    const { handlers } = wire();
    await expect(
      handlers.get("protonmail_mail_send")!({ to: "x@x.com", subject: "", body: "b" }),
    ).rejects.toThrow();
  });
});
