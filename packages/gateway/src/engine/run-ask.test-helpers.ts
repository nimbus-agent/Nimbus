// Test-only helper for `nimbus explain last` wiring tests (Task 6, spec §4.2/§4.3). Dependency
// injection throughout — never `mock.module`, which is process-global and leaks across the
// combined `bun test packages/cli/src` run on CI Linux.
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";

import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { LlmRouter } from "../llm/router.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { recordExplainToolCall } from "./agent-request-context.ts";
import type { AskExplainRecorder } from "./ask-explain-recorder.ts";
import type { ClassifiedIntent } from "./router.ts";
import type { RunAskParams } from "./run-ask.ts";
import type { ConnectorDispatcher } from "./types.ts";

const stubBase = join(tmpdir(), "nimbus-run-ask-wiring-test");
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

function emptyAsyncIterable(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

/**
 * A Mastra-agent double that optionally throws (`throwsOnGenerate`, for the "model" stage of the
 * failed-ask test) and optionally records tool calls onto the current `agentRequestContext` store
 * before returning (`agentToolCalls`, draining exactly like a real `wrapToolOutput` caller would —
 * see `engine/agent.ts`).
 */
function fakeConversationalAgent(opts: {
  reply?: string;
  agentToolCalls?: readonly string[];
  throwsOnGenerate?: boolean;
}): Agent {
  const reply = opts.reply ?? "agent reply";
  const run = (): { text: string } => {
    if (opts.throwsOnGenerate === true) {
      throw new Error("boom");
    }
    for (const toolId of opts.agentToolCalls ?? []) {
      recordExplainToolCall({
        toolId,
        service: "nimbus",
        status: "ok",
        durationMs: 1,
        params: undefined,
      });
    }
    return { text: reply };
  };
  return {
    generate: async () => run(),
    stream: async () => {
      const out = run();
      return { fullStream: emptyAsyncIterable(), text: Promise.resolve(out.text) };
    },
  } as unknown as Agent;
}

/** A local-router double. Throwing here is what exercises the local→agent fallback (spec §4.2). */
function fakeLocalRouter(opts: { throws: string }): LlmRouter {
  return {
    prefersLocal: () => true,
    enforcesAirGap: () => false,
    generate: async () => {
      throw new Error(opts.throws);
    },
  } as unknown as LlmRouter;
}

const DEFAULT_CLASSIFIED: ClassifiedIntent = {
  intent: "unknown",
  entities: {},
  requiresHITL: false,
  confidence: 0,
};

export type MakeRunAskParamsOptions = {
  readonly input: string;
  readonly explainRecorder?: AskExplainRecorder;
  readonly clientId?: string;
  /** Makes the given stage fail with a real, unrecovered throw (spec §4.2's "failed" route). */
  readonly throwAt?: "classification" | "model";
  /**
   * Wires a local router whose `generate` always throws with this message, exercising the
   * local-router→agent fallback (spec §4.2). Omitted entirely (rather than defaulted) when unset,
   * so every other test here routes straight through the Mastra agent double — the simplest path
   * to the `agent_tools` route these tests are about.
   */
  readonly localRouterThrows?: string;
  /** Tool ids the fake conversational agent records via `recordExplainToolCall` before replying. */
  readonly agentToolCalls?: readonly string[];
};

/**
 * Builds a `RunAskParams` over a fresh in-memory `LocalIndex` seeded with exactly one item whose
 * title matches none of the questions these tests ask — so `buildLocalIndexedContext` reliably
 * returns `undefined` and every test here routes through the conversational agent
 * (`agent_tools`), never `local_context`, keeping the wiring under test isolated from Task 4's
 * retrieval logic (covered by its own tests).
 */
export function makeRunAskParams(opts: MakeRunAskParamsOptions): RunAskParams {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  db.run(
    "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) " +
      "VALUES ('seed:1', 'seed', 'note', '1', 'unrelated seeded item', 1, 1)",
  );
  const localIndex = new LocalIndex(db);

  const classify = async (): Promise<ClassifiedIntent> => {
    if (opts.throwAt === "classification") {
      throw new Error("boom");
    }
    return DEFAULT_CLASSIFIED;
  };

  return {
    input: opts.input,
    stream: false,
    clientId: opts.clientId ?? "test-client",
    paths: stubPaths,
    consentCoordinator: stubConsent,
    localIndex,
    dispatcher: stubDispatcher,
    egressSink: NULL_EGRESS_SINK,
    sendChunk: () => {},
    classify,
    conversationalAgent: fakeConversationalAgent({
      throwsOnGenerate: opts.throwAt === "model",
      ...(opts.agentToolCalls === undefined ? {} : { agentToolCalls: opts.agentToolCalls }),
    }),
    ...(opts.localRouterThrows === undefined
      ? {}
      : { llmRouter: fakeLocalRouter({ throws: opts.localRouterThrows }) }),
    ...(opts.explainRecorder === undefined ? {} : { explainRecorder: opts.explainRecorder }),
  };
}
