import { describe, expect, test } from "bun:test";
import type { IPCClient } from "@nimbus-dev/client";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";

import { IpcContext, type IpcContextValue } from "./ipc-context.ts";
import { StubIpcClient } from "./test-helpers/stub-client.ts";
import { useIpcPoll } from "./useIpcPoll.ts";

function ctxValue(client: StubIpcClient): IpcContextValue {
  return {
    client: client.asClient(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as IpcContextValue["logger"],
  };
}

/** Build a context value backed by a raw IPCClient (not a StubIpcClient). */
function rawCtxValue(client: IPCClient): IpcContextValue {
  return {
    client,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as IpcContextValue["logger"],
  };
}

/** Build a minimal IPCClient that delegates `call` to the given handler. */
function makeClient(callFn: (method: string) => Promise<unknown>): IPCClient {
  return {
    call: (method: string) => callFn(method),
    onNotification: () => undefined,
    connect: async () => undefined,
    disconnect: async () => undefined,
  } as unknown as IPCClient;
}

function Harness({
  stub: _stub,
  method,
  onData,
}: {
  readonly stub: StubIpcClient;
  readonly method: string;
  readonly onData: (data: unknown) => void;
}): React.JSX.Element {
  const state = useIpcPoll<unknown>(method, 50, "idle");
  React.useEffect(() => {
    if (state.data !== null) {
      onData(state.data);
    }
  }, [state.data, onData]);
  return <Text>{state.data === null ? "loading" : "ok"}</Text>;
}

describe("useIpcPoll", () => {
  test("fires immediately on mount", async () => {
    const stub = new StubIpcClient({ results: { "test.method": { ok: true } } });
    let calls = 0;
    const harness = (
      <IpcContext.Provider value={ctxValue(stub)}>
        <Harness
          stub={stub}
          method="test.method"
          onData={() => {
            calls++;
          }}
        />
      </IpcContext.Provider>
    );
    const { unmount } = render(harness);
    await new Promise((r) => setTimeout(r, 10));
    expect(stub.calls.length).toBeGreaterThanOrEqual(1);
    expect(stub.calls[0]?.method).toBe("test.method");
    unmount();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test("re-fires on interval", async () => {
    const stub = new StubIpcClient({ results: { "test.method": { ok: true } } });
    const { unmount } = render(
      <IpcContext.Provider value={ctxValue(stub)}>
        <Harness stub={stub} method="test.method" onData={() => undefined} />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 350));
    unmount();
    expect(stub.calls.length).toBeGreaterThanOrEqual(3);
  });

  test("paused when mode is 'disconnected'", async () => {
    const stub = new StubIpcClient({ results: { "test.method": { ok: true } } });
    function PausedHarness(): React.JSX.Element {
      useIpcPoll<unknown>("test.method", 50, "disconnected");
      return <Text>paused</Text>;
    }
    const { unmount } = render(
      <IpcContext.Provider value={ctxValue(stub)}>
        <PausedHarness />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    unmount();
    expect(stub.calls).toHaveLength(0);
  });

  test("exposes error state without crashing", async () => {
    const stub = new StubIpcClient({
      errors: { "test.method": new Error("socket down") },
    });
    function ErrorHarness(): React.JSX.Element {
      const r = useIpcPoll<unknown>("test.method", 50, "idle");
      return <Text>{r.error === null ? "no-error" : "error"}</Text>;
    }
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctxValue(stub)}>
        <ErrorHarness />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(lastFrame()).toContain("error");
    unmount();
  });

  // --- NEW BRANCH COVERAGE TESTS ---

  test("wraps non-Error thrown value in Error (instanceof false arm)", async () => {
    // Throwing a plain string exercises `e instanceof Error ? e : new Error(String(e))` false arm.
    const nonErrorClient = makeClient(async (_method) => {
      // Intentionally throw a non-Error to exercise the String() fallback in catch.
      throw "network-failure-string";
    });

    let capturedError: Error | null = null;

    function NonErrorHarness(): React.JSX.Element {
      const r = useIpcPoll<unknown>("any.method", 50, "idle");
      React.useEffect(() => {
        if (r.error !== null) {
          capturedError = r.error;
        }
      }, [r.error]);
      return <Text>{r.error === null ? "no-error" : r.error.message}</Text>;
    }

    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={rawCtxValue(nonErrorClient)}>
        <NonErrorHarness />
      </IpcContext.Provider>,
    );

    await new Promise((r) => setTimeout(r, 200));
    expect(lastFrame()).toContain("network-failure-string");
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedError?.message).toBe("network-failure-string");
    unmount();
  });

  test("stale is true when mode is disconnected", async () => {
    const stub = new StubIpcClient({ results: { "test.method": { ok: true } } });
    let capturedStale: boolean | null = null;

    function StaleHarness(): React.JSX.Element {
      const r = useIpcPoll<unknown>("test.method", 50, "disconnected");
      React.useEffect(() => {
        capturedStale = r.stale;
      }, [r.stale]);
      return <Text>{r.stale ? "stale" : "fresh"}</Text>;
    }

    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctxValue(stub)}>
        <StaleHarness />
      </IpcContext.Provider>,
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain("stale");
    expect(capturedStale).toBe(true);
    unmount();
  });

  test("stale is false when mode is idle", async () => {
    const stub = new StubIpcClient({ results: { "test.method": { ok: true } } });
    let capturedStale: boolean | null = null;

    function FreshHarness(): React.JSX.Element {
      const r = useIpcPoll<unknown>("test.method", 200, "idle");
      React.useEffect(() => {
        capturedStale = r.stale;
      }, [r.stale]);
      return <Text>{r.stale ? "stale" : "fresh"}</Text>;
    }

    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctxValue(stub)}>
        <FreshHarness />
      </IpcContext.Provider>,
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain("fresh");
    expect(capturedStale).toBe(false);
    unmount();
  });

  test("interval is cleared on unmount (timer cleanup runs)", async () => {
    // Verify the cleanup function clears the timer — unmounting stops new calls.
    const stub = new StubIpcClient({ results: { "test.method": { ok: true } } });
    const { unmount } = render(
      <IpcContext.Provider value={ctxValue(stub)}>
        <Harness stub={stub} method="test.method" onData={() => undefined} />
      </IpcContext.Provider>,
    );
    // Let the immediate call fire
    await new Promise((r) => setTimeout(r, 20));
    const callsAtUnmount = stub.calls.length;
    unmount();
    // Wait longer than two intervals — if timer was cleared, no new calls arrive
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.calls).toHaveLength(callsAtUnmount);
  });

  test("unmount while in-flight success: setData is not called after unmount", async () => {
    // Use a slow-resolving client so we can unmount before the call resolves.
    // The mountedRef guard prevents setState on an unmounted component.
    let resolveCall: ((value: unknown) => void) | null = null;
    const slowClient = makeClient(
      (_method) =>
        new Promise((resolve) => {
          resolveCall = resolve;
        }),
    );

    let dataWasSet = false;

    function SlowHarness(): React.JSX.Element {
      const r = useIpcPoll<unknown>("slow.method", 10000, "idle");
      React.useEffect(() => {
        if (r.data !== null) {
          dataWasSet = true;
        }
      }, [r.data]);
      return <Text>{r.data === null ? "waiting" : "got-data"}</Text>;
    }

    const { unmount } = render(
      <IpcContext.Provider value={rawCtxValue(slowClient)}>
        <SlowHarness />
      </IpcContext.Provider>,
    );

    // Give the effect time to launch the async call, then unmount before it resolves
    await new Promise((r) => setTimeout(r, 10));
    unmount();

    // Resolve the in-flight call — mountedRef.current is false, so setData must not run
    resolveCall?.({ payload: "late-data" });
    await new Promise((r) => setTimeout(r, 20));

    expect(dataWasSet).toBe(false);
  });

  test("unmount while in-flight error: setError is not called after unmount", async () => {
    // Similar to the success case but exercises the error-path mountedRef guard.
    let rejectCall: ((reason: unknown) => void) | null = null;
    const slowErrorClient = makeClient(
      (_method) =>
        new Promise((_resolve, reject) => {
          rejectCall = reject;
        }),
    );

    let errorWasSet = false;

    function SlowErrorHarness(): React.JSX.Element {
      const r = useIpcPoll<unknown>("slow.method", 10000, "idle");
      React.useEffect(() => {
        if (r.error !== null) {
          errorWasSet = true;
        }
      }, [r.error]);
      return <Text>{r.error === null ? "no-error" : "error"}</Text>;
    }

    const { unmount } = render(
      <IpcContext.Provider value={rawCtxValue(slowErrorClient)}>
        <SlowErrorHarness />
      </IpcContext.Provider>,
    );

    await new Promise((r) => setTimeout(r, 10));
    unmount();

    // Reject the in-flight call — mountedRef.current is false, so setError must not run
    rejectCall?.(new Error("late-error"));
    await new Promise((r) => setTimeout(r, 20));

    expect(errorWasSet).toBe(false);
  });

  test("error state is cleared after subsequent successful poll", async () => {
    // Verifies that setError(null) is called on success path and that a prior
    // error is replaced by a successful result.
    let callCount = 0;
    const toggleClient = makeClient(async (_method) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("first-call-fails");
      }
      return { recovered: true };
    });

    let lastError: Error | null = null;
    let lastData: unknown = null;

    function ToggleHarness(): React.JSX.Element {
      const r = useIpcPoll<unknown>("toggle.method", 100, "idle");
      React.useEffect(() => {
        lastError = r.error;
      }, [r.error]);
      React.useEffect(() => {
        lastData = r.data;
      }, [r.data]);
      return <Text>{r.error !== null ? "err" : r.data !== null ? "ok" : "wait"}</Text>;
    }

    const { unmount } = render(
      <IpcContext.Provider value={rawCtxValue(toggleClient)}>
        <ToggleHarness />
      </IpcContext.Provider>,
    );

    // Wait for first (error) + second (success) polls — immediate + 100ms interval
    await new Promise((r) => setTimeout(r, 400));
    unmount();

    // After the second call succeeds, error should be null and data should be set
    expect(lastData).toEqual({ recovered: true });
    expect(lastError).toBeNull();
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
