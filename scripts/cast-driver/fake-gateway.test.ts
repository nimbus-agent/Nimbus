import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventsScript, FakeGateway } from "./fake-gateway.ts";

let tmpDir: string;
let socketPath: string;
let gateway: FakeGateway;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fake-gateway-"));
  socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\nimbus-test-${process.pid}-${Date.now()}`
      : join(tmpDir, "gw.sock");
});

afterEach(async () => {
  await gateway?.stop();
});

async function rpc(method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    client.on("connect", () => {
      const msg = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`;
      client.write(msg);
    });
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buf.slice(0, newlineIdx);
        const parsed = JSON.parse(line);
        client.end();
        resolve(parsed);
      }
    });
    client.on("error", reject);
  });
}

describe("FakeGateway", () => {
  test("starts and accepts a JSON-RPC connection", async () => {
    gateway = new FakeGateway({ socketPath, events: { steps: [] } });
    await gateway.start();
    const resp = await rpc("status.gateway", {});
    expect(resp).toMatchObject({ jsonrpc: "2.0", id: 1 });
  });

  test("returns METHOD_NOT_FOUND for unscripted methods", async () => {
    gateway = new FakeGateway({ socketPath, events: { steps: [] } });
    await gateway.start();
    const resp = (await rpc("totally.unknown", {})) as { error?: { code: number } };
    expect(resp.error?.code).toBe(-32601);
  });

  test("emits scripted notifications after engine.askStream", async () => {
    const events: EventsScript = {
      steps: [
        {
          input: 'nimbus ask "hi"',
          notifications: [
            { method: "engine.streamToken", params: { streamId: "s1", token: "hello\n" } },
            { method: "engine.streamDone", params: { streamId: "s1", result: "hello" } },
          ],
        },
      ],
    };
    gateway = new FakeGateway({ socketPath, events });
    await gateway.start();

    const notifs: Array<{ method: string }> = [];
    await new Promise<void>((resolve, reject) => {
      const client = connect(socketPath);
      client.on("connect", () => {
        client.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "engine.askStream",
            params: { prompt: "hi" },
          })}\n`,
        );
      });
      let buf = "";
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const parsed = JSON.parse(line);
          if (parsed.id === undefined) {
            notifs.push({ method: parsed.method as string });
            if (parsed.method === "engine.streamDone") {
              client.end();
              resolve();
            }
          }
          nl = buf.indexOf("\n");
        }
      });
      client.on("error", reject);
    });

    expect(notifs.map((n) => n.method)).toEqual(["engine.streamToken", "engine.streamDone"]);
  });

  test("pauses at consent.request until consent.respond arrives", async () => {
    const events: EventsScript = {
      steps: [
        {
          input: 'nimbus ask "do thing"',
          notifications: [
            { method: "consent.request", params: { requestId: "r1", prompt: "approve?" } },
            { method: "engine.streamToken", params: { streamId: "s1", token: "done\n" } },
          ],
        },
      ],
    };
    gateway = new FakeGateway({ socketPath, events });
    await gateway.start();

    const received: string[] = [];
    let respondedAfterConsent = false;
    await new Promise<void>((resolve, reject) => {
      const client = connect(socketPath);
      client.on("connect", () => {
        client.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "engine.askStream",
            params: { prompt: "x" },
          })}\n`,
        );
      });
      let buf = "";
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const parsed = JSON.parse(line);
          if (parsed.id === undefined && parsed.method !== undefined) {
            received.push(parsed.method as string);
            if (parsed.method === "consent.request") {
              setTimeout(() => {
                client.write(
                  `${JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "consent.respond",
                    params: { requestId: "r1", approved: true },
                  })}\n`,
                );
                respondedAfterConsent = true;
              }, 50);
            }
            if (parsed.method === "engine.streamToken") {
              expect(respondedAfterConsent).toBe(true);
              client.end();
              resolve();
            }
          }
          nl = buf.indexOf("\n");
        }
      });
      client.on("error", reject);
    });

    expect(received).toEqual(["consent.request", "engine.streamToken"]);
  });

  test("records consent.respond decisions for assertion", async () => {
    const events: EventsScript = {
      steps: [
        {
          input: "ask",
          notifications: [{ method: "consent.request", params: { requestId: "r1", prompt: "?" } }],
        },
      ],
    };
    gateway = new FakeGateway({ socketPath, events });
    await gateway.start();

    await new Promise<void>((resolve) => {
      const client = connect(socketPath);
      client.on("connect", () => {
        client.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "engine.askStream", params: {} })}\n`,
        );
      });
      let buf = "";
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          client.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "consent.respond",
              params: { requestId: "r1", approved: false },
            })}\n`,
          );
          setTimeout(() => {
            client.end();
            resolve();
          }, 30);
        }
      });
    });

    expect(gateway.consentDecisions).toEqual([{ requestId: "r1", approved: false }]);
  });

  test("stop() releases the socket", async () => {
    gateway = new FakeGateway({ socketPath, events: { steps: [] } });
    await gateway.start();
    await gateway.stop();
    const g2 = new FakeGateway({ socketPath, events: { steps: [] } });
    await g2.start();
    await g2.stop();
  });

  test("per-step trigger: emits notifications when declared trigger method fires", async () => {
    const events: EventsScript = {
      steps: [
        {
          input: 'nimbus expert "latency"',
          trigger: "agents.expert",
          notifications: [
            {
              method: "expert.briefReady",
              params: {
                sessionId: "s1",
                brief: "## Report\n\nAll good.\n",
                findings: { gaps: [], findings: [] },
              },
            },
          ],
          methodResponses: {
            "agents.expert": { sessionId: "s1" },
          },
        },
      ],
    };
    gateway = new FakeGateway({ socketPath, events });
    await gateway.start();

    const notifs: Array<{ method: string }> = [];
    await new Promise<void>((resolve, reject) => {
      const client = connect(socketPath);
      client.on("connect", () => {
        client.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "agents.expert",
            params: { topicOrFile: "latency" },
          })}\n`,
        );
      });
      let buf = "";
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const parsed = JSON.parse(line) as {
            id?: number;
            method?: string;
            result?: unknown;
          };
          if (parsed.id === undefined && parsed.method !== undefined) {
            notifs.push({ method: parsed.method });
            if (parsed.method === "expert.briefReady") {
              client.end();
              resolve();
            }
          }
          nl = buf.indexOf("\n");
        }
      });
      client.on("error", reject);
    });

    expect(notifs.map((n) => n.method)).toEqual(["expert.briefReady"]);
  });

  test("respondAfterNotifications: notifications arrive before the RPC response", async () => {
    const events: EventsScript = {
      steps: [
        {
          input: 'nimbus ask "test"',
          trigger: "agent.invoke",
          respondAfterNotifications: true,
          notifications: [
            { method: "agent.chunk", params: { text: "chunk1\n" } },
            { method: "agent.chunk", params: { text: "chunk2\n" } },
          ],
          methodResponses: { "agent.invoke": { reply: "" } },
        },
      ],
    };
    gateway = new FakeGateway({ socketPath, events });
    await gateway.start();

    const received: Array<{ kind: "notif" | "response"; method?: string }> = [];
    await new Promise<void>((resolve, reject) => {
      const client = connect(socketPath);
      client.on("connect", () => {
        client.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent.invoke", params: {} })}\n`,
        );
      });
      let buf = "";
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const parsed = JSON.parse(line) as {
            id?: number;
            method?: string;
            result?: unknown;
          };
          if (parsed.id !== undefined) {
            received.push({ kind: "response" });
            client.end();
            resolve();
          } else if (parsed.method !== undefined) {
            received.push({ kind: "notif", method: parsed.method });
          }
          nl = buf.indexOf("\n");
        }
      });
      client.on("error", reject);
    });

    expect(received[0]).toMatchObject({ kind: "notif", method: "agent.chunk" });
    expect(received[1]).toMatchObject({ kind: "notif", method: "agent.chunk" });
    expect(received[2]).toMatchObject({ kind: "response" });
  });

  test("per-step trigger: engine.askStream is not a trigger when step declares different method", async () => {
    const events: EventsScript = {
      steps: [
        {
          input: 'nimbus expert "latency"',
          trigger: "agents.expert",
          notifications: [
            {
              method: "expert.briefReady",
              params: { sessionId: "s1", brief: "ok", findings: { gaps: [], findings: [] } },
            },
          ],
          methodResponses: { "agents.expert": { sessionId: "s1" } },
        },
      ],
    };
    gateway = new FakeGateway({ socketPath, events });
    await gateway.start();

    const resp = (await rpc("engine.askStream", { prompt: "hi" })) as {
      error?: { code: number };
    };
    expect(resp.error?.code).toBe(-32601);
  });
});
