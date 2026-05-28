import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { IpcContext, type IpcContextValue } from "./ipc-context.ts";
import { StubIpcClient } from "./test-helpers/stub-client.ts";
import { WatcherPane } from "./WatcherPane.tsx";

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

describe("WatcherPane", () => {
  test("renders summary: active and firing counts", async () => {
    const stub = new StubIpcClient({
      results: {
        "watcher.list": [
          { id: "w1", name: "one", active: true, firing: true },
          { id: "w2", name: "two", active: true, firing: false },
          { id: "w3", name: "three", active: false, firing: false },
        ],
      },
    });
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <WatcherPane mode="idle" />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("2 active");
    expect(frame).toContain("1 firing");
    unmount();
  });

  test("lists up to 5 firing watcher names, truncates beyond", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      id: `w${String(i)}`,
      name: `watcher-${String(i)}`,
      active: true,
      firing: true,
    }));
    const stub = new StubIpcClient({ results: { "watcher.list": rows } });
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <WatcherPane mode="idle" />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("watcher-0");
    expect(frame).toContain("watcher-4");
    expect(frame).not.toContain("watcher-5");
    expect(frame).toContain("…2 more");
    unmount();
  });

  test("BUG-004: shows 'No watchers configured' when the list is empty", async () => {
    const stub = new StubIpcClient({ results: { "watcher.list": [] } });
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <WatcherPane mode="idle" />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No watchers configured");
    expect(frame).not.toContain("0 active, 0 firing");
    unmount();
  });

  test("(stale) marker when disconnected", async () => {
    const stub = new StubIpcClient({ results: { "watcher.list": [] } });
    const { lastFrame, unmount } = render(
      <IpcContext.Provider value={ctx(stub)}>
        <WatcherPane mode="disconnected" />
      </IpcContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame() ?? "").toContain("(stale)");
    unmount();
  });
});
