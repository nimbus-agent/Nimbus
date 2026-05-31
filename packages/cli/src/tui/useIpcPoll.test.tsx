import { describe, expect, test } from "bun:test";
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
    await new Promise((r) => setTimeout(r, 160));
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
    expect(stub.calls.length).toBe(0);
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
    await new Promise((r) => setTimeout(r, 80));
    expect(lastFrame()).toContain("error");
    unmount();
  });
});
