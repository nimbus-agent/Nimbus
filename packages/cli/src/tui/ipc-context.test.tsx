import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";

import { IpcContext, useIpc } from "./ipc-context.ts";
import { ipcContextFor } from "./test-helpers/context.ts";
import { StubIpcClient } from "./test-helpers/stub-client.ts";

// ---------------------------------------------------------------------------
// IpcContext default value
// ---------------------------------------------------------------------------

describe("IpcContext", () => {
  test("is a React context object (non-null export)", () => {
    // Verify the named export exists and looks like a React context.
    // The behavioral proof of its null-default is in the "outside Provider"
    // tests below (useIpc throws exactly when no Provider is present).
    expect(IpcContext).toBeDefined();
    expect(typeof IpcContext.Provider).toBe("object");
    expect(typeof IpcContext.Consumer).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// useIpc — inside a provider (ctx !== null branch)
// ---------------------------------------------------------------------------

describe("useIpc inside Provider", () => {
  test("returns the context value when rendered inside a Provider", () => {
    const stub = new StubIpcClient({ results: { "health.ping": { ok: true } } });
    const ctxValue = ipcContextFor(stub);

    let capturedCtx: ReturnType<typeof useIpc> | undefined;

    function Consumer(): React.JSX.Element {
      capturedCtx = useIpc();
      return <Text>ok</Text>;
    }

    const { unmount } = render(
      <IpcContext.Provider value={ctxValue}>
        <Consumer />
      </IpcContext.Provider>,
    );

    unmount();

    // Must have captured a non-null value
    expect(capturedCtx).toBeDefined();
    // The client property must be the stub's IPCClient facade
    expect(capturedCtx?.client).toBe(ctxValue.client);
    // The logger property must be the same logger object
    expect(capturedCtx?.logger).toBe(ctxValue.logger);
  });

  test("returns fresh context when a different stub is provided", () => {
    const stub = new StubIpcClient({
      results: { "health.ping": { pong: true } },
    });
    const ctxValue = ipcContextFor(stub);

    let capturedCtx: ReturnType<typeof useIpc> | undefined;

    function Spy(): React.JSX.Element {
      capturedCtx = useIpc();
      return <Text>spy</Text>;
    }

    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctxValue}>
        <Spy />
      </IpcContext.Provider>,
    );

    expect(lastFrame()).toContain("spy");
    unmount();

    // Confirm the client identity matches what was injected
    expect(capturedCtx?.client).toBe(stub.asClient());
  });
});

// ---------------------------------------------------------------------------
// useIpc — outside a provider (ctx === null branch → throws)
// ---------------------------------------------------------------------------

describe("useIpc outside Provider", () => {
  test("throws when rendered without a Provider", () => {
    // Capture the error thrown by useIpc() when ctx is null.
    // Use an error boundary so ink does not crash the test process.
    let thrownError: Error | undefined;

    class ErrorBoundary extends React.Component<
      { readonly children: React.ReactNode },
      { readonly caught: boolean }
    > {
      constructor(props: { readonly children: React.ReactNode }) {
        super(props);
        this.state = { caught: false };
      }

      static getDerivedStateFromError(): { caught: boolean } {
        return { caught: true };
      }

      componentDidCatch(err: Error): void {
        thrownError = err;
      }

      render(): React.ReactNode {
        if (this.state.caught) {
          return <Text>caught</Text>;
        }
        return this.props.children;
      }
    }

    function Uncovered(): React.JSX.Element {
      // useIpc called with no Provider above — ctx will be null
      useIpc();
      return <Text>unreachable</Text>;
    }

    const { unmount } = render(
      <ErrorBoundary>
        <Uncovered />
      </ErrorBoundary>,
    );

    unmount();

    // The error boundary must have caught an error from useIpc
    expect(thrownError).toBeInstanceOf(Error);
    expect(thrownError?.message).toBe("useIpc must be used inside <IpcContext.Provider>");
  });

  test("error message is the exact sentinel string (second boundary instance)", () => {
    // Verify the precise message text is stable — a refactor must not silently
    // change the string that users see in crash reports.
    let msg = "";

    class Boundary extends React.Component<
      { readonly children: React.ReactNode },
      { readonly caught: boolean }
    > {
      constructor(props: { readonly children: React.ReactNode }) {
        super(props);
        this.state = { caught: false };
      }

      static getDerivedStateFromError(): { caught: boolean } {
        return { caught: true };
      }

      componentDidCatch(err: Error): void {
        msg = err.message;
      }

      render(): React.ReactNode {
        if (this.state.caught) return <Text>err</Text>;
        return this.props.children;
      }
    }

    function NoProvider(): React.JSX.Element {
      useIpc();
      return <Text>never</Text>;
    }

    const { unmount } = render(
      <Boundary>
        <NoProvider />
      </Boundary>,
    );

    unmount();

    expect(msg).toBe("useIpc must be used inside <IpcContext.Provider>");
  });
});
