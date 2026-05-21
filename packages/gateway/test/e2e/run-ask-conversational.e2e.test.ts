/**
 * Q2 §7.3 — gateway ask routing (no subprocess, no cloud): verifies `runAsk` uses
 * the Mastra path for high-confidence unknown intent when `conversationalAgent` is set.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";
import type { ConnectorDispatcher } from "../../src/engine/types.ts";
import type { LocalIndex } from "../../src/index/local-index.ts";
import type { ConsentCoordinator } from "../../src/ipc/consent.ts";
import type { PlatformPaths } from "../../src/platform/paths.ts";

/** Absolute path so `mock.module` matches the same specifier Bun uses for `./router.ts` from `run-ask.ts`. */
const routerModuleAbs = join(import.meta.dir, "..", "..", "src", "engine", "router.ts");
const runAskModuleAbs = join(import.meta.dir, "..", "..", "src", "engine", "run-ask.ts");

// Captured BEFORE any test installs a `mock.module(routerModuleAbs, …)` override.
// `bun:test` discovers and runs every *.test.ts in the package via one `bun test`
// invocation, and `mock.restore()` does NOT undo `mock.module()` registrations —
// only call counts and `mock(fn)` spies. Without the afterAll() below, the final
// per-test mock leaks into sibling files (e.g. `engine/router.test.ts`), which
// then receive this file's stubbed `classifyIntent` and fail in confusing ways.
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
    } as PlatformPaths,
    consentCoordinator: {
      requestConsent: async () => false,
      rejectAllPending: () => {
        /* noop */
      },
      pendingCount: () => 0,
    } as ConsentCoordinator,
    localIndex: {
      recordAudit: (): void => {
        /* ToolExecutor writes audit before connector dispatch */
      },
    } as unknown as LocalIndex,
    dispatcher: {
      dispatch: async () => ({}),
    } as ConnectorDispatcher,
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
    // Restore the real `router.ts` exports so sibling test files in the same
    // `bun test` invocation get the genuine `classifyIntent`. See the
    // `realRouterExports` comment near the top of this file for why.
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
    // Previously this returned the static LOW_CONFIDENCE_REPLY ("I am not sure …"),
    // which masked the conversational agent for any non-file query whenever the
    // classifier produced borderline confidence. With an agent attached, route to
    // it regardless of confidence — it can answer general questions or degrade
    // gracefully if the index is empty.
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
    // The planner's LOW_CONFIDENCE_REPLY remains as a fallback for callers that
    // don't pass a conversationalAgent — currently only test fixtures and any
    // future headless invocation that opts out of the Mastra path.
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
      dispatcher: { dispatch } as unknown as ConnectorDispatcher,
    });

    expect(dispatch).toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(r.reply).toContain("filesystem_search_files");
  });
});
