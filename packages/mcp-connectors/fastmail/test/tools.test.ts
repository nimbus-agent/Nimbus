import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { McpListResult } from "../../shared/mcp-tool-kit.ts";
import type { JmapClient, JmapEmailView, SendMailInput, SendMailResult } from "../src/jmap-core.ts";
import { FASTMAIL_TOOL_NAMES, registerFastmailTools } from "../src/tools.ts";

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

function sampleView(): JmapEmailView {
  return {
    id: "M9",
    messageId: "<a@x>",
    subject: "Hello",
    from: ["Ada <ada@x.com>"],
    to: ["team@x.com"],
    cc: [],
    receivedAt: "2026-05-31T00:00:00Z",
    attachments: [{ name: "secret.pdf", sizeBytes: 1234, mimeType: "application/pdf" }],
    preview: "the body preview",
  };
}

class FakeClient implements JmapClient {
  public lastSearch: { query: string; limit: number } | null = null;
  public lastGetId = "";
  public lastSend: SendMailInput | null = null;
  async list(_limit: number): Promise<JmapEmailView[]> {
    return [sampleView()];
  }
  async get(id: string): Promise<JmapEmailView | null> {
    this.lastGetId = id;
    return id === "M9" ? sampleView() : null;
  }
  async search(query: string, limit: number): Promise<JmapEmailView[]> {
    this.lastSearch = { query, limit };
    return [sampleView()];
  }
  async send(input: SendMailInput): Promise<SendMailResult> {
    this.lastSend = input;
    return { emailId: "M-new", submissionId: "S1" };
  }
}

function parse(result: McpListResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function wire() {
  const { server, handlers } = fakeServer();
  const client = new FakeClient();
  registerFastmailTools(server, client);
  return { handlers, client };
}

describe("registerFastmailTools", () => {
  test("registers exactly the documented tool surface", () => {
    const { handlers } = wire();
    expect([...handlers.keys()].sort((a, b) => a.localeCompare(b))).toEqual(
      [...FASTMAIL_TOOL_NAMES].sort((a, b) => a.localeCompare(b)),
    );
  });

  test("fastmail_list returns the header/metadata/preview view — never attachment bytes", async () => {
    const { handlers } = wire();
    const out = parse(await handlers.get("fastmail_list")!({ limit: 10 }));
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
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("blobId");
    expect(serialized).not.toContain("base64");
  });

  test("fastmail_get fetches by id and returns null for an unknown id", async () => {
    const { handlers, client } = wire();
    const hit = parse(await handlers.get("fastmail_get")!({ id: "M9" }));
    expect((hit.item as Record<string, unknown>).id).toBe("M9");
    expect(client.lastGetId).toBe("M9");
    const miss = parse(await handlers.get("fastmail_get")!({ id: "ZZZ" }));
    expect(miss.item).toBeNull();
  });

  test("fastmail_search passes the query + clamped limit through", async () => {
    const { handlers, client } = wire();
    const out = parse(await handlers.get("fastmail_search")!({ query: "invoice", limit: 5 }));
    expect(out.matches as unknown[]).toHaveLength(1);
    expect(client.lastSearch).toEqual({ query: "invoice", limit: 5 });
  });

  test("fastmail_mail_send delegates to the client and returns the submission result", async () => {
    const { handlers, client } = wire();
    const out = parse(
      await handlers.get("fastmail_mail_send")!({
        to: "dest@x.com",
        subject: "Hi",
        body: "Body",
        cc: "c@x.com",
      }),
    );
    expect(client.lastSend).toEqual({
      to: "dest@x.com",
      subject: "Hi",
      body: "Body",
      cc: "c@x.com",
    });
    expect(out.emailId).toBe("M-new");
    expect(out.submissionId).toBe("S1");
  });

  test("rejects invalid args (empty subject)", async () => {
    const { handlers } = wire();
    await expect(
      handlers.get("fastmail_mail_send")!({ to: "x@x.com", subject: "", body: "b" }),
    ).rejects.toThrow();
  });
});
