import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { App } from "./App.tsx";
import { IpcContext } from "./ipc-context.ts";
import { ipcContextFor, makeHistoryPath } from "./test-helpers/context.ts";
import { StubIpcClient } from "./test-helpers/stub-client.ts";

function setupStub(): StubIpcClient {
  return new StubIpcClient({
    results: {
      "connector.listStatus": [],
      "watcher.list": [],
      "engine.askStream": { streamId: "s-test" },
      "consent.respond": { ok: true },
    },
  });
}

/** Standard App render + cleanup lifecycle; returns the render handles and a teardown fn. */
function renderApp(stub: StubIpcClient): {
  readonly stdin: ReturnType<typeof render>["stdin"];
  readonly lastFrame: ReturnType<typeof render>["lastFrame"];
  readonly teardown: () => void;
} {
  const history = makeHistoryPath("nimbus-tui-app-");
  const ink = render(
    <IpcContext.Provider value={ipcContextFor(stub)}>
      <App historyPath={history.path} onExit={() => undefined} />
    </IpcContext.Provider>,
  );
  return {
    stdin: ink.stdin,
    lastFrame: ink.lastFrame,
    teardown: () => {
      ink.unmount();
      history.cleanup();
    },
  };
}

const SETTLE_MS = 20;
const SUBMIT_SETTLE_MS = 60;

async function settle(ms = SETTLE_MS): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Headless CI (`process.stdout.isTTY === false`) silently routes through the
// non-interactive fallback; without these stubs the interactive render branch
// — which is the bulk of App.tsx — never executes and coverage stalls below
// 60%. Restore in `afterEach` so tests in other files are unaffected.
let origIsTty: PropertyDescriptor | undefined;
let origColumns: PropertyDescriptor | undefined;
let origRows: PropertyDescriptor | undefined;

beforeEach(() => {
  origIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  origColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  origRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
});

afterEach(() => {
  if (origIsTty !== undefined) {
    Object.defineProperty(process.stdout, "isTTY", origIsTty);
  } else {
    delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
  }
  if (origColumns !== undefined) Object.defineProperty(process.stdout, "columns", origColumns);
  if (origRows !== undefined) Object.defineProperty(process.stdout, "rows", origRows);
});

describe("App state machine", () => {
  test("idle → streaming on submit", async () => {
    const stub = setupStub();
    const { stdin, lastFrame, teardown } = renderApp(stub);
    await settle();
    stdin.write("hello");
    stdin.write("\r");
    await settle(SUBMIT_SETTLE_MS);
    expect(stub.calls.some((c) => c.method === "engine.askStream")).toBe(true);
    expect(lastFrame() ?? "").toContain("hello");
    teardown();
  });

  test("streaming → idle on engine.streamDone", async () => {
    const stub = setupStub();
    const { stdin, lastFrame, teardown } = renderApp(stub);
    await settle();
    stdin.write("hi");
    stdin.write("\r");
    await settle(SUBMIT_SETTLE_MS);
    stub.emit("engine.streamToken", { streamId: "s-test", text: "response" });
    stub.emit("engine.streamDone", { streamId: "s-test" });
    await settle(SUBMIT_SETTLE_MS);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("response");
    expect(frame).toContain("nimbus>");
    teardown();
  });

  test("engine.streamError appends an error line and returns to idle", async () => {
    const stub = setupStub();
    const { stdin, lastFrame, teardown } = renderApp(stub);
    await settle();
    stdin.write("oops");
    stdin.write("\r");
    await settle(SUBMIT_SETTLE_MS);
    stub.emit("engine.streamError", { streamId: "s-test", error: "downstream failed" });
    await settle(SUBMIT_SETTLE_MS);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("downstream failed");
    expect(frame).toContain("❌");
    teardown();
  });

  test("BUG-004: renders the keybind footer in idle mode", async () => {
    const stub = setupStub();
    const { lastFrame, teardown } = renderApp(stub);
    await settle();
    // The TUI now ships a one-line footer so first-time users have an anchor
    // for the only universally-available exit keybind.
    expect(lastFrame() ?? "").toContain("Ctrl+C twice to exit");
    teardown();
  });

  test("BUG-004: right pane is enclosed in a single-line box border", async () => {
    const stub = setupStub();
    const { lastFrame, teardown } = renderApp(stub);
    await settle();
    const frame = lastFrame() ?? "";
    // Ink's borderStyle="single" emits Unicode box-drawing characters.
    // Asserting `│` (vertical bar) is the cheapest invariant that survives
    // terminal-width changes and content reshuffles.
    expect(frame).toContain("│");
    teardown();
  });

  test("BUG-005: every engine.askStream call carries a sessionId, and consecutive submits share it", async () => {
    const stub = setupStub();
    const { stdin, teardown } = renderApp(stub);
    await settle();

    stdin.write("first prompt");
    stdin.write("\r");
    await settle(SUBMIT_SETTLE_MS);
    stub.emit("engine.streamDone", { streamId: "s-test" });
    await settle(SUBMIT_SETTLE_MS);

    stdin.write("second prompt");
    stdin.write("\r");
    await settle(SUBMIT_SETTLE_MS);

    const askCalls = stub.calls.filter((c) => c.method === "engine.askStream");
    expect(askCalls.length).toBe(2);
    const firstParams = askCalls[0]?.params as { input: string; sessionId?: string };
    const secondParams = askCalls[1]?.params as { input: string; sessionId?: string };
    // Without sessionId threading, the gateway can't load prior turns and the
    // multi-turn UX (BUG-005) breaks.
    expect(typeof firstParams.sessionId).toBe("string");
    expect(firstParams.sessionId?.length).toBeGreaterThan(0);
    // Crucial invariant: same TUI session → same sessionId across submits.
    expect(secondParams.sessionId).toBe(firstParams.sessionId);
    teardown();
  });

  test("disconnect banner appears when an IPC call throws ECONNRESET", async () => {
    const stub = new StubIpcClient({
      errors: { "engine.askStream": new Error("ECONNRESET") },
      results: { "connector.listStatus": [], "watcher.list": [] },
    });
    const { stdin, lastFrame, teardown } = renderApp(stub);
    await settle();
    stdin.write("hi");
    stdin.write("\r");
    await settle(SUBMIT_SETTLE_MS);
    expect(lastFrame() ?? "").toContain("Gateway disconnected");
    teardown();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Coverage extensions (Phase 5 coverage-floor T10)
  //
  // The cases below were chosen to drive App.tsx state branches not exercised
  // by the existing happy-path tests above: HITL batch handling (approve and
  // reject paths), the Ctrl+C cancel-hint surface, the narrow-layout render
  // branch, and the malformed-payload guards in notification handlers.
  // ──────────────────────────────────────────────────────────────────────────

  test("awaiting-hitl: hitlBatch notification renders consent banner with action JSON", async () => {
    const stub = setupStub();
    const { lastFrame, teardown } = renderApp(stub);
    await settle();
    stub.emit("agent.hitlBatch", {
      batchId: "b-1",
      requests: [{ actionId: "a-1", action: "github.create_pr", params: { repo: "acme/api" } }],
    });
    await settle();
    const frame = lastFrame() ?? "";
    // The consent banner is the proof that hitl-requested transitioned mode
    // and that formatHitlBanner ran end-to-end (lines 79-95).
    expect(frame).toContain("consent required");
    expect(frame).toContain("github.create_pr");
    expect(frame).toContain("acme/api");
    expect(frame).toContain("nimbus[hitl]>");
    teardown();
  });

  test("awaiting-hitl: 'a' key approves all requests and emits consent.respond", async () => {
    const stub = setupStub();
    const { stdin, lastFrame, teardown } = renderApp(stub);
    await settle();
    stub.emit("agent.hitlBatch", {
      batchId: "b-approve",
      requests: [
        { actionId: "a-1", action: "github.create_pr", params: { title: "p1" } },
        { actionId: "a-2", action: "slack.post_message", params: { channel: "#x" } },
      ],
    });
    await settle();
    // Two 'a' presses advance the cursor past requests.length, triggering the
    // resolve effect that posts consent.respond and switches mode back.
    stdin.write("a");
    await settle();
    stdin.write("a");
    await settle(SUBMIT_SETTLE_MS);
    const consentCalls = stub.calls.filter((c) => c.method === "consent.respond");
    expect(consentCalls.length).toBe(1);
    const params = consentCalls[0]?.params as {
      batchId: string;
      decisions: Array<{ actionId: string; approved: boolean }>;
    };
    expect(params.batchId).toBe("b-approve");
    expect(params.decisions).toHaveLength(2);
    expect(params.decisions.every((d) => d.approved)).toBe(true);
    // "approved all" outcome line lands in the result stream (line 27).
    expect(lastFrame() ?? "").toContain("approved all");
    teardown();
  });

  test("awaiting-hitl: 'r' key rejects all requests and renders rejected-all outcome", async () => {
    const stub = setupStub();
    const { stdin, lastFrame, teardown } = renderApp(stub);
    await settle();
    stub.emit("agent.hitlBatch", {
      batchId: "b-reject",
      requests: [{ actionId: "a-1", action: "github.merge_pr", params: { num: 7 } }],
    });
    await settle();
    stdin.write("r");
    await settle(SUBMIT_SETTLE_MS);
    const consentCalls = stub.calls.filter((c) => c.method === "consent.respond");
    expect(consentCalls.length).toBe(1);
    const params = consentCalls[0]?.params as {
      decisions: Array<{ approved: boolean }>;
    };
    expect(params.decisions[0]?.approved).toBe(false);
    // "rejected all" outcome (line 30).
    expect(lastFrame() ?? "").toContain("rejected all");
    teardown();
  });

  test("awaiting-hitl: mixed approve/reject yields 'approved 1, rejected 1' outcome", async () => {
    const stub = setupStub();
    const { stdin, lastFrame, teardown } = renderApp(stub);
    await settle();
    stub.emit("agent.hitlBatch", {
      batchId: "b-mixed",
      requests: [
        { actionId: "a-1", action: "act1", params: {} },
        { actionId: "a-2", action: "act2", params: {} },
      ],
    });
    await settle();
    stdin.write("a");
    await settle();
    stdin.write("r");
    await settle(SUBMIT_SETTLE_MS);
    const frame = lastFrame() ?? "";
    // Exercises the mixed branch in formatHitlOutcome (line 32).
    expect(frame).toContain("approved 1");
    expect(frame).toContain("rejected 1");
    teardown();
  });

  test("awaiting-hitl: 'd' key is a no-op and 'q' triggers exit + reject", async () => {
    const stub = setupStub();
    let exitCalls = 0;
    const history = makeHistoryPath("nimbus-tui-app-q-");
    const ink = render(
      <IpcContext.Provider value={ipcContextFor(stub)}>
        <App
          historyPath={history.path}
          onExit={() => {
            exitCalls++;
          }}
        />
      </IpcContext.Provider>,
    );
    await settle();
    stub.emit("agent.hitlBatch", {
      batchId: "b-quit",
      requests: [{ actionId: "a-1", action: "act1", params: { k: "v" } }],
    });
    await settle();
    // 'd' is the explicit no-op branch (lines 244-246); no consent posted yet.
    ink.stdin.write("d");
    await settle();
    expect(stub.calls.some((c) => c.method === "consent.respond")).toBe(false);
    // 'q' posts a full-reject consent and calls onExit (lines 247-258).
    ink.stdin.write("q");
    await settle(SUBMIT_SETTLE_MS);
    expect(exitCalls).toBe(1);
    const consentCalls = stub.calls.filter((c) => c.method === "consent.respond");
    expect(consentCalls.length).toBe(1);
    const params = consentCalls[0]?.params as {
      decisions: Array<{ approved: boolean }>;
    };
    expect(params.decisions.every((d) => d.approved === false)).toBe(true);
    ink.unmount();
    history.cleanup();
  });

  test("Ctrl+C in idle shows the press-again cancel hint", async () => {
    const stub = setupStub();
    const { stdin, lastFrame, teardown } = renderApp(stub);
    await settle();
    // First Ctrl+C sets the cancel-hint flag (line 301-303) without exiting.
    stdin.write("\x03");
    await settle();
    expect(lastFrame() ?? "").toContain("Press again within 2s to exit");
    teardown();
  });

  test("Ctrl+C during streaming triggers local cancel + 'canceled by user' line", async () => {
    const stub = setupStub();
    const { stdin, lastFrame, teardown } = renderApp(stub);
    await settle();
    stdin.write("running");
    stdin.write("\r");
    await settle(SUBMIT_SETTLE_MS);
    // Now in streaming mode; Ctrl+C should dispatch 'cancel' (line 292) and
    // append the local-cancel error entry (lines 293-300).
    stdin.write("\x03");
    await settle(SUBMIT_SETTLE_MS);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("canceled by user");
    // Back to idle after cancel.
    expect(frame).toContain("nimbus>");
    teardown();
  });

  test("double Ctrl+C within window calls onExit", async () => {
    const stub = setupStub();
    let exitCalls = 0;
    const history = makeHistoryPath("nimbus-tui-app-dblc-");
    const ink = render(
      <IpcContext.Provider value={ipcContextFor(stub)}>
        <App
          historyPath={history.path}
          onExit={() => {
            exitCalls++;
          }}
        />
      </IpcContext.Provider>,
    );
    await settle();
    ink.stdin.write("\x03");
    await settle();
    ink.stdin.write("\x03");
    await settle();
    // Second Ctrl+C within DOUBLE_CTRL_C_WINDOW_MS (2000 ms) — line 283-284.
    expect(exitCalls).toBe(1);
    ink.unmount();
    history.cleanup();
  });

  test("renders the right pane with three panes (connector, watcher, subtask)", async () => {
    const stub = setupStub();
    const { lastFrame, teardown } = renderApp(stub);
    await settle();
    const frame = lastFrame() ?? "";
    // Asserts the wide-layout right-pane content (lines 354-356) reached the
    // frame. The narrow branch (327-334) cannot be driven via this test setup
    // because Ink's useStdout() exposes its own mock columns, independent of
    // process.stdout.columns. Both branches share the same three pane
    // components, so this assertion at least covers the wide path explicitly.
    expect(frame).toContain("Connectors");
    expect(frame).toContain("Watchers");
    expect(frame).toContain("Sub-Tasks");
    teardown();
  });

  test("malformed engine.streamToken payload is ignored (type-guard returns false)", async () => {
    const stub = setupStub();
    const { stdin, lastFrame, teardown } = renderApp(stub);
    await settle();
    stdin.write("hello");
    stdin.write("\r");
    await settle(SUBMIT_SETTLE_MS);
    // Drives the `return false` branches of isStreamTokenPayload (line 37) /
    // isStreamDonePayload (line 45) / isStreamErrorPayload (line 53).
    stub.emit("engine.streamToken", null);
    stub.emit("engine.streamToken", { streamId: 42 });
    stub.emit("engine.streamDone", null);
    stub.emit("engine.streamError", "not-an-object");
    await settle();
    // Send a real token after the malformed ones — the buffer should contain
    // only the good payload, proving the malformed ones were dropped.
    stub.emit("engine.streamToken", { streamId: "s-test", text: "real" });
    await settle();
    expect(lastFrame() ?? "").toContain("real");
    teardown();
  });

  test("malformed agent.hitlBatch payload is ignored", async () => {
    const stub = setupStub();
    const { lastFrame, teardown } = renderApp(stub);
    await settle();
    // Each of these exercises a different early-return branch in
    // isHitlBatchPayload (lines 59-77).
    stub.emit("agent.hitlBatch", null);
    stub.emit("agent.hitlBatch", { batchId: 1, requests: [] });
    stub.emit("agent.hitlBatch", { batchId: "b", requests: "not-array" });
    stub.emit("agent.hitlBatch", {
      batchId: "b",
      requests: [{ actionId: 1, action: "x" }],
    });
    await settle();
    // None should have flipped the UI into HITL mode.
    expect(lastFrame() ?? "").not.toContain("consent required");
    expect(lastFrame() ?? "").toContain("nimbus>");
    teardown();
  });
});
