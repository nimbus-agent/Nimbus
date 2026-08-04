import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";
import { NULL_EGRESS_SINK } from "../../src/egress/egress-ledger.ts";
import type { LocalIndex } from "../../src/index/local-index.ts";

const routerModuleAbs = join(import.meta.dir, "..", "..", "src", "engine", "router.ts");
const runAskModuleAbs = join(import.meta.dir, "..", "..", "src", "engine", "run-ask.ts");

const realRouterExports: Record<string, unknown> = { ...(await import(routerModuleAbs)) };

function baseParams(
  sendChunk: (t: string) => void,
): Omit<import("../../src/engine/run-ask.ts").RunAskParams, "conversationalAgent"> {
  return {
    input: "what can you do?",
    stream: false,
    clientId: "c1",
    paths: {
      configDir: "/c",
      dataDir: "/d",
      logDir: "/l",
      socketPath: "/s",
      extensionsDir: "/e",
      tempDir: "/t",
    },
    consentCoordinator: {
      requestConsent: async () => false,
      rejectAllPending: () => {
        /* noop */
      },
      pendingCount: () => 0,
    },
    localIndex: {
      recordAudit: (): void => {
        /* ToolExecutor writes audit before connector dispatch */
      },
    } as unknown as LocalIndex,
    dispatcher: {
      dispatch: async () => ({}),
    },
    // I29: RunAskParams.egressSink is a REQUIRED dep now (no more implicit NULL_EGRESS_SINK
    // fallback inside run-ask.ts). This mock-heavy e2e-style test isn't exercising the real
    // egress ledger, so it states that choice explicitly rather than inheriting a silent default.
    egressSink: NULL_EGRESS_SINK,
    sendChunk,
  };
}

describe("runAsk conversational routing (e2e-style)", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  afterAll(() => {
    mock.module(routerModuleAbs, () => realRouterExports);
  });

  test("high-confidence unknown + conversationalAgent calls agent.generate", async () => {
    mock.module(routerModuleAbs, () => ({
      classifyIntent: async () => ({
        intent: "unknown" as const,
        entities: {},
        requiresHITL: false,
        confidence: 0.95,
      }),
    }));

    const { runAsk } = await import(runAskModuleAbs);

    const generate = mock(async () => ({ text: "from-mock-agent" }));
    const agent = { generate } as unknown as Agent;

    const r = await runAsk({
      ...baseParams(() => {
        /* noop */
      }),
      conversationalAgent: agent,
    });

    expect(r.reply).toBe("from-mock-agent");
    expect(generate).toHaveBeenCalled();
  });

  test("high-confidence unknown without agent falls back to planner canned reply", async () => {
    mock.module(routerModuleAbs, () => ({
      classifyIntent: async () => ({
        intent: "unknown" as const,
        entities: {},
        requiresHITL: false,
        confidence: 0.95,
      }),
    }));

    const { runAsk } = await import(runAskModuleAbs);

    const r = await runAsk({
      ...baseParams(() => {
        /* noop */
      }),
    });

    expect(r.reply).toContain("indexed sandbox");
    expect(r.reply).toContain("move");
  });

  test("low-confidence unknown routes to agent when one is available", async () => {
    mock.module(routerModuleAbs, () => ({
      classifyIntent: async () => ({
        intent: "unknown" as const,
        entities: {},
        requiresHITL: false,
        confidence: 0.4,
      }),
    }));

    const { runAsk } = await import(runAskModuleAbs);

    const generate = mock(async () => ({ text: "from-mock-agent" }));
    const agent = { generate } as unknown as Agent;

    const r = await runAsk({
      ...baseParams(() => {
        /* noop */
      }),
      conversationalAgent: agent,
    });

    expect(r.reply).toBe("from-mock-agent");
    expect(generate).toHaveBeenCalled();
  });

  test("low-confidence unknown without agent still hits planner reply (test-only path)", async () => {
    mock.module(routerModuleAbs, () => ({
      classifyIntent: async () => ({
        intent: "unknown" as const,
        entities: {},
        requiresHITL: false,
        confidence: 0.4,
      }),
    }));

    const { runAsk } = await import(runAskModuleAbs);

    const r = await runAsk({
      ...baseParams(() => {
        /* noop */
      }),
    });

    expect(r.reply).toContain("not sure");
  });

  test("file_search still uses executor path when pattern present", async () => {
    mock.module(routerModuleAbs, () => ({
      classifyIntent: async () => ({
        intent: "file_search" as const,
        entities: { pattern: "*.md" },
        requiresHITL: false,
        confidence: 0.95,
      }),
    }));

    const { runAsk } = await import(runAskModuleAbs);

    const generate = mock(async () => ({ text: "should-not-run" }));
    const dispatch = mock(async () => ({ hits: [] }));
    const agent = { generate } as unknown as Agent;

    const r = await runAsk({
      ...baseParams(() => {
        /* noop */
      }),
      conversationalAgent: agent,
      dispatcher: { dispatch },
    });

    expect(dispatch).toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(r.reply).toContain("filesystem_search_files");
  });
});
