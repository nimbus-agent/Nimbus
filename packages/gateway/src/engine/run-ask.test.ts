import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";

import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { LlmRouter } from "../llm/router.ts";
import type { SessionChunk, SessionMemoryStore } from "../memory/session-memory-store.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { agentRequestContext } from "./agent-request-context.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { runAsk } from "./run-ask.ts";
import type { ConnectorDispatcher } from "./types.ts";

const stubBase = join(tmpdir(), "nimbus-run-ask-test");
const stubPaths: PlatformPaths = {
  configDir: join(stubBase, "cfg"),
  dataDir: join(stubBase, "data"),
  logDir: join(stubBase, "logs"),
  socketPath: join(stubBase, "gateway.sock"),
  extensionsDir: join(stubBase, "ext"),
  tempDir: join(stubBase, "tmp"),
};

const stubConsent: ConsentCoordinator = {
  async requestConsent(): Promise<boolean> {
    return false;
  },
  rejectAllPending(): void {},
  pendingCount(): number {
    return 0;
  },
};

const stubDispatcher: ConnectorDispatcher = {
  async dispatch(): Promise<unknown> {
    return null;
  },
};

function fakeConversationalAgent(reply = "agent reply"): Agent {
  const emptyAsyncIterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  return {
    generate: async () => ({ text: reply }),
    stream: async () => ({
      fullStream: emptyAsyncIterable,
      text: Promise.resolve(reply),
    }),
  } as unknown as Agent;
}

function fakeLocalRouter(calls: string[], reply = "local reply"): LlmRouter {
  return {
    prefersLocal: () => true,
    generate: async (opts: { prompt: string }) => {
      calls.push(opts.prompt);
      return {
        text: reply,
        tokensIn: 1,
        tokensOut: 2,
        modelUsed: "local-test-model:latest",
        isLocal: true,
        provider: "ollama" as const,
      };
    },
  } as unknown as LlmRouter;
}

function spySessionMemoryStore(): {
  store: SessionMemoryStore;
  appended: SessionChunk[];
} {
  const appended: SessionChunk[] = [];
  const store = {
    append: async (chunk: SessionChunk) => {
      appended.push(chunk);
    },
  } as unknown as SessionMemoryStore;
  return { store, appended };
}

describe("runAsk", () => {
  test("returns onboarding guidance when index has zero items (no LLM path)", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const localIndex = new LocalIndex(db);
    const out = await runAsk({
      input: "What did I work on yesterday?",
      stream: false,
      clientId: "test-client",
      paths: stubPaths,
      consentCoordinator: stubConsent,
      localIndex,
      dispatcher: stubDispatcher,
      sendChunk: () => {},
    });
    expect(out.reply).toContain("No data indexed yet");
    expect(out.reply).toContain("nimbus connector auth");
    localIndex.close();
  });

  test("BUG-005: appends user input + assistant reply to SessionMemoryStore when sessionId is in the request context", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES ('x:1', 'x', 'note', '1', 't', 1, 1)",
    );
    const localIndex = new LocalIndex(db);
    const { store, appended } = spySessionMemoryStore();

    await agentRequestContext.run({ sessionId: "sess-runask" }, async () => {
      await runAsk({
        input: "draft a gmail to me",
        stream: false,
        clientId: "test-client",
        paths: stubPaths,
        consentCoordinator: stubConsent,
        localIndex,
        dispatcher: stubDispatcher,
        sendChunk: () => {},
        conversationalAgent: fakeConversationalAgent("ok, draft created"),
        sessionMemoryStore: store,
        classify: async () => ({
          intent: "unknown",
          entities: {},
          requiresHITL: false,
          confidence: 0,
        }),
      });
    });

    expect(appended.length).toBe(2);
    expect(appended[0]).toMatchObject({
      sessionId: "sess-runask",
      role: "user",
      text: "draft a gmail to me",
    });
    expect(appended[1]).toMatchObject({
      sessionId: "sess-runask",
      role: "assistant",
      text: "ok, draft created",
    });

    localIndex.close();
  });

  test("BUG-005: skips append when sessionId is absent (preserves the no-memory path)", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES ('x:1', 'x', 'note', '1', 't', 1, 1)",
    );
    const localIndex = new LocalIndex(db);
    const { store, appended } = spySessionMemoryStore();

    await runAsk({
      input: "draft a gmail to me",
      stream: false,
      clientId: "test-client",
      paths: stubPaths,
      consentCoordinator: stubConsent,
      localIndex,
      dispatcher: stubDispatcher,
      sendChunk: () => {},
      conversationalAgent: fakeConversationalAgent("ok, draft created"),
      sessionMemoryStore: store,
      classify: async () => ({
        intent: "unknown",
        entities: {},
        requiresHITL: false,
        confidence: 0,
      }),
    });

    expect(appended.length).toBe(0);
    localIndex.close();
  });

  test("uses local LLM router when remote classifier has no API key", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, modified_at, synced_at)
       VALUES ('github:zaalgol/helpdesk#issue-1', 'github', 'issue', 'zaalgol/helpdesk#issue-1', 'add a smoke test', 'Create a basic smoke test for the helpdesk app.', 'https://github.com/zaalgol/helpdesk/issues/1', 1, 1)`,
    );
    const localIndex = new LocalIndex(db);
    const prompts: string[] = [];

    const out = await runAsk({
      input: "What should I do for the smoke test issue?",
      stream: false,
      clientId: "test-client",
      paths: stubPaths,
      consentCoordinator: stubConsent,
      localIndex,
      dispatcher: stubDispatcher,
      sendChunk: () => {},
      llmRouter: fakeLocalRouter(prompts, "Use the GitHub issue context."),
      classify: async () => {
        throw new GatewayAgentUnavailableError({ reason: "no_api_key" });
      },
    });

    expect(out.reply).toBe("Use the GitHub issue context.");
    expect(out.modelMeta?.isLocal).toBe(true);
    expect(prompts[0]).toContain("Indexed Nimbus context");
    expect(prompts[0]).toContain('<tool_output service="nimbus" tool="localIndex.searchRanked">');
    expect(prompts[0]).toContain('"service":"github"');
    expect(prompts[0]).toContain('"indexedType":"issue"');
    expect(prompts[0]).toContain('"title":"add a smoke test"');
    expect(prompts[0]).toContain("Create a basic smoke test");
    localIndex.close();
  });
});
