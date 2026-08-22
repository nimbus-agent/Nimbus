import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

const mod = await import("./_agent-brief-cli.ts");
const { runAgentBriefCli } = mod;

// `runAgentBriefCli` ends a failure with `process.exit(2)`, which would take the test runner with
// it. `captureExit` turns that into a throw so the exit path is observable.
const out = createStreamCapture({ captureExit: true });

/**
 * F30 — a fast `briefError` printed Bun's unhandled-rejection stack, with compiled source frames,
 * before the clean message.
 *
 * `runAgentBriefCli` created `briefPromise`, then `await`ed the RPC, then awaited the promise:
 *
 *   const briefPromise = awaitBrief(client, spec, …);
 *   await client.call(`agents.${spec.kind}`, spec.params);   // nothing watching briefPromise
 *   const { brief, findings } = await briefPromise;          // handler attached only now
 *
 * A `briefError` arriving in that window is an unhandled rejection AT THAT INSTANT, so Bun prints
 * a code frame and a ten-frame stack before the outer `catch` gets to write the clean line. The
 * gateway's fastest rejection — a ref that resolves to nothing, needing no work — lands squarely
 * there, which is why `nimbus pre-mortem "S2"` showed it and `why` / `janitor` / `impact` did not:
 * those render a brief with gap notes instead of rejecting.
 *
 * The clean path always worked. The defect is what the runtime printed BESIDE it, so a test that
 * exercises the catch proves nothing — this one asserts the rejection is watched from creation.
 */

interface Handlers {
  [event: string]: (params: unknown) => void;
}

/** A gateway whose `briefError` lands DURING the RPC, the window the race lived in. */
function rejectingDuringCall(handlers: Handlers, message: string) {
  return {
    connect: (): void => {},
    disconnect: (): void => {},
    onNotification: (event: string, handler: (params: unknown) => void): void => {
      handlers[event] = handler;
    },
    call: async (): Promise<unknown> => {
      // Fire the error before the RPC settles — the gateway can reject a bad ref faster than it
      // can answer the call that requested it.
      handlers["premortem.briefError"]?.({ error: message });
      // Then let a MACROTASK elapse before resolving. Without this the RPC settles in the same
      // microtask checkpoint, a handler attaches immediately, and the runtime never considers
      // the rejection unhandled — the test would pass against the unfixed code. A real RPC is a
      // socket round-trip, which is many ticks.
      await new Promise((r) => setTimeout(r, 5));
      return { sessionId: "s1" };
    },
  };
}

const spec = {
  kind: "premortem" as const,
  params: { ref: "S2" },
  json: false,
  guard: (f: unknown): f is Record<string, unknown> => typeof f === "object" && f !== null,
};

describe("runAgentBriefCli — a fast briefError (F30)", () => {
  beforeEach(() => {
    out.stdoutChunks.length = 0;
    out.stderrChunks.length = 0;
    out.install();
  });
  afterEach(() => {
    out.restore();
    clearFixture();
  });

  it("does not leave the brief promise unwatched while the RPC is in flight", async () => {
    // The property, stated as the runtime sees it: between creating `briefPromise` and awaiting
    // it, a rejection must already have a handler. Observed here by capturing Bun's own
    // unhandled-rejection event rather than by scraping stderr, which the harness intercepts.
    const handlers: Handlers = {};
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: rejectingDuringCall(handlers, "pre-mortem: 'S2' was not found"),
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (e: Event): void => {
      unhandled.push((e as Event & { reason?: unknown }).reason);
      e.preventDefault();
    };
    globalThis.addEventListener("unhandledrejection", onUnhandled);
    try {
      await expect(runAgentBriefCli(spec)).rejects.toThrow("process.exit(2)");
      // Let the microtask queue drain — an unhandled rejection is reported a tick after the fact.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      globalThis.removeEventListener("unhandledrejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it("still reports the error message, so the guard did not swallow it", async () => {
    // The other direction. Attaching a `.catch(() => {})` to silence the runtime must not also
    // silence the error — the message is the whole output of a failed brief.
    const handlers: Handlers = {};
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: rejectingDuringCall(handlers, "pre-mortem: 'S2' was not found"),
    });

    await expect(runAgentBriefCli(spec)).rejects.toThrow("process.exit(2)");
    expect(out.stderrChunks.join("")).toContain("pre-mortem: 'S2' was not found");
  });
});
