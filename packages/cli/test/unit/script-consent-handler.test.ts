import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPCClient } from "../../src/ipc-client/index.ts";
import { registerScriptConsentHandler } from "../../src/lib/interactive-ipc-handlers.ts";

type Notification = { method: string; handler: (params: unknown) => Promise<void> | void };

function makeFakeClient(): {
  client: IPCClient;
  notifications: Notification[];
  calls: Array<{ method: string; params: unknown }>;
} {
  const notifications: Notification[] = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    onNotification(method: string, handler: (params: unknown) => Promise<void> | void): void {
      notifications.push({ method, handler });
    },
    async call(method: string, params: unknown): Promise<unknown> {
      calls.push({ method, params });
      return undefined;
    },
  } as unknown as IPCClient;
  return { client, notifications, calls };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "script-consent-handler-"));
});
afterEach(() => {
  // tmpDir cleaned up by OS on next reboot; test isolation via fresh dir each test
});

describe("registerScriptConsentHandler", () => {
  test("consumes one JSONL line per consent.request and dispatches consent.respond", async () => {
    const source = join(tmpDir, "decisions.jsonl");
    writeFileSync(
      source,
      '{"approved":true}\n{"approved":false,"note":"reject for cast"}\n',
      "utf8",
    );

    const { client, notifications, calls } = makeFakeClient();
    registerScriptConsentHandler(client, source);

    const handler = notifications.find((n) => n.method === "consent.request")?.handler;
    expect(handler).toBeDefined();
    if (handler === undefined) throw new Error("consent.request handler was not registered");

    await handler({ requestId: "req-1", prompt: "First action" });
    await handler({ requestId: "req-2", prompt: "Second action" });

    expect(calls).toEqual([
      { method: "consent.respond", params: { requestId: "req-1", approved: true } },
      { method: "consent.respond", params: { requestId: "req-2", approved: false } },
    ]);
  });

  test("writes prompt + decision to stdout for cast capture", async () => {
    const source = join(tmpDir, "decisions.jsonl");
    writeFileSync(source, '{"approved":true}\n', "utf8");

    const { client, notifications } = makeFakeClient();
    registerScriptConsentHandler(client, source);
    const handler = notifications.find((n) => n.method === "consent.request")?.handler;
    if (handler === undefined) throw new Error("consent.request handler not registered");

    let captured = "";
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await handler({ requestId: "req-X", prompt: "Approve action?" });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(captured).toContain("[consent.request] Approve action?");
    expect(captured).toContain("[scripted: approve]");
  });

  test("appends note when present", async () => {
    const source = join(tmpDir, "decisions.jsonl");
    writeFileSync(source, '{"approved":true,"note":"intentional approve"}\n', "utf8");

    const { client, notifications } = makeFakeClient();
    registerScriptConsentHandler(client, source);
    const handler = notifications.find((n) => n.method === "consent.request")?.handler;
    if (handler === undefined) throw new Error("consent.request handler was not registered");

    let captured = "";
    const restore = process.stdout.write;
    process.stdout.write = ((c: string | Uint8Array) => {
      captured += typeof c === "string" ? c : new TextDecoder().decode(c);
      return true;
    }) as typeof process.stdout.write;
    try {
      await handler({ requestId: "r", prompt: "p" });
    } finally {
      process.stdout.write = restore;
    }
    expect(captured).toContain("[scripted: approve] — intentional approve");
  });

  test("errors when file does not exist", () => {
    const { client } = makeFakeClient();
    expect(() => registerScriptConsentHandler(client, join(tmpDir, "missing.jsonl"))).toThrow(
      /script consent source not found/i,
    );
  });

  test("errors when JSONL line is malformed", () => {
    const source = join(tmpDir, "decisions.jsonl");
    writeFileSync(source, "not-json\n", "utf8");

    const { client } = makeFakeClient();
    expect(() => registerScriptConsentHandler(client, source)).toThrow(/malformed/i);
  });

  test("errors when JSONL runs out", async () => {
    const source = join(tmpDir, "decisions.jsonl");
    writeFileSync(source, '{"approved":true}\n', "utf8");

    const { client, notifications } = makeFakeClient();
    registerScriptConsentHandler(client, source);
    const handler = notifications.find((n) => n.method === "consent.request")?.handler;
    if (handler === undefined) throw new Error("consent.request handler was not registered");

    await handler({ requestId: "r1", prompt: "p1" });
    await expect(handler({ requestId: "r2", prompt: "p2" })).rejects.toThrow(
      /no scripted decision/i,
    );
  });
});
