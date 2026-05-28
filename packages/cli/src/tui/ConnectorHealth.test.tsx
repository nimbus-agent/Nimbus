import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { ConnectorHealth } from "./ConnectorHealth.tsx";
import { IpcContext, type IpcContextValue } from "./ipc-context.ts";
import { StubIpcClient } from "./test-helpers/stub-client.ts";

function ctx(client: StubIpcClient): IpcContextValue {
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

describe("ConnectorHealth", () => {
  test("renders a line per connector with a status glyph", async () => {
    const stub = new StubIpcClient({
      results: {
        "connector.listStatus": [
          { serviceId: "github", status: "ok" },
          { serviceId: "slack", status: "paused" },
          { serviceId: "notion", status: "error" },
        ],
      },
    });
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <ConnectorHealth mode="idle" />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("github");
    expect(frame).toContain("slack");
    expect(frame).toContain("notion");
    expect(frame).toContain("●");
    expect(frame).toContain("◐");
    expect(frame).toContain("○");
    unmount();
  });

  test("prefixes degraded statuses (backoff/error) with ⚠", async () => {
    const stub = new StubIpcClient({
      results: { "connector.listStatus": [{ serviceId: "slack", status: "error" }] },
    });
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <ConnectorHealth mode="idle" />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame() ?? "").toContain("⚠");
    unmount();
  });

  test("shows (stale) marker in the title when disconnected", async () => {
    const stub = new StubIpcClient({ results: { "connector.listStatus": [] } });
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <ConnectorHealth mode="disconnected" />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame() ?? "").toContain("(stale)");
    unmount();
  });

  test("shows loading state before first poll response", () => {
    const stub = new StubIpcClient({ results: { "connector.listStatus": [] } });
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <ConnectorHealth mode="idle" />
      </IpcContext.Provider>,
    );
    expect(lastFrame() ?? "").toContain("Loading connector status…");
    unmount();
  });

  test("BUG-004: shows 'No connectors registered' when poll returned an empty list", async () => {
    const stub = new StubIpcClient({ results: { "connector.listStatus": [] } });
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <ConnectorHealth mode="idle" />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No connectors registered");
    expect(frame).not.toContain("(none)");
    unmount();
  });

  test("syncing maps to the half-circle glyph (in-flight)", async () => {
    const stub = new StubIpcClient({
      results: { "connector.listStatus": [{ serviceId: "github", status: "syncing" }] },
    });
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <ConnectorHealth mode="idle" />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame() ?? "").toContain("◐");
    unmount();
  });

  test("backoff maps to the empty-circle glyph (failure)", async () => {
    const stub = new StubIpcClient({
      results: { "connector.listStatus": [{ serviceId: "slack", status: "backoff" }] },
    });
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <ConnectorHealth mode="idle" />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame() ?? "").toContain("○");
    unmount();
  });
});
