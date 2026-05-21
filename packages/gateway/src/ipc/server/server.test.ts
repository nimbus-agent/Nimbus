/**
 * Targeted unit tests for `createIpcServer` in `server.ts`.
 *
 * These tests cover the thin wiring paths that the dispatcher and
 * inline-handler tests don't reach: `broadcast`, `setAgentInvokeHandler`,
 * `setWorkflowRunHandler`, `setUpdater`, and the `voiceService.onMicrophoneStateChange`
 * callback wiring. No real socket is started — the tests interact with the
 * returned `IPCServer` object directly.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import { createIpcServer } from "./server.ts";

function makeMinimalServer() {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);

  const broadcastCalls: Array<{ method: string; params: Record<string, unknown> }> = [];

  const server = createIpcServer({
    listenPath: "/tmp/nimbus-server-test.sock",
    vault: createMockVault(),
    version: "0.0.0-test",
    localIndex: new LocalIndex(db),
    onClientConnected: () => {},
  });

  return { server, broadcastCalls, db };
}

describe("createIpcServer", () => {
  test("broadcast does not throw when no clients are connected", () => {
    const { server } = makeMinimalServer();
    // With zero connected clients this is a no-op; confirm it doesn't throw.
    expect(() => server.broadcast("test.event", { foo: "bar" })).not.toThrow();
  });

  test("setAgentInvokeHandler replaces the handler without throwing", () => {
    const { server } = makeMinimalServer();
    const handler = async (_ctx: unknown) => ({ reply: "ok" });
    expect(() => server.setAgentInvokeHandler(handler as never)).not.toThrow();
    // Setting back to undefined is also valid
    expect(() => server.setAgentInvokeHandler(undefined)).not.toThrow();
  });

  test("setWorkflowRunHandler replaces the handler without throwing", () => {
    const { server } = makeMinimalServer();
    const handler = async (_ctx: unknown) => ({ ok: true });
    expect(() => server.setWorkflowRunHandler(handler as never)).not.toThrow();
    expect(() => server.setWorkflowRunHandler(undefined)).not.toThrow();
  });

  test("setUpdater attaches the updater reference without throwing", () => {
    const { server } = makeMinimalServer();
    const fakeUpdater = {} as never;
    expect(() => server.setUpdater(fakeUpdater)).not.toThrow();
  });

  test("voiceService.onMicrophoneStateChange is wired via broadcastNotification", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);

    // Capture the callback that createIpcServer stores on voiceService
    let storedCallback: ((e: { active: boolean; source: string }) => void) | undefined;
    const fakeVoiceService = {
      set onMicrophoneStateChange(cb:
        | ((e: { active: boolean; source: string }) => void)
        | undefined,) {
        storedCallback = cb;
      },
    };

    createIpcServer({
      listenPath: "/tmp/nimbus-server-voice-test.sock",
      vault: createMockVault(),
      version: "0.0.0-test",
      voiceService: fakeVoiceService as never,
    });

    // The constructor should have wired the callback
    expect(typeof storedCallback).toBe("function");
    // Invoking it with zero clients should not throw
    expect(() => storedCallback?.({ active: true, source: "microphone" })).not.toThrow();
  });
});
