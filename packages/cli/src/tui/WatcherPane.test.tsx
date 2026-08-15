import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { WATCHER_RECENT_FIRE_WINDOW_MS } from "./constants.ts";
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

/**
 * Build a row in the shape `watcher.list` actually returns — the `watcher` table's own
 * columns, `enabled` as 0/1 and `last_fired_at` as epoch ms or null.
 *
 * These tests previously stubbed a BARE ARRAY of `{ id, name, active, firing }`. That
 * shape exists nowhere: the handler wraps rows in `{ watchers: [...] }`, and `active`
 * and `firing` are derived in the pane, not selected from the table. The fake therefore
 * agreed with the component's wrong assumption instead of with the Gateway, and the
 * suite stayed green while the pane rendered "No watchers configured" for every real
 * user. Keeping the envelope and the column names here is the point of the fixture.
 */
function row(
  id: string,
  name: string,
  opts: { enabled?: number; firedMsAgo?: number | null } = {},
): Record<string, unknown> {
  const firedMsAgo = opts.firedMsAgo ?? null;
  return {
    id,
    name,
    enabled: opts.enabled ?? 1,
    last_fired_at: firedMsAgo === null ? null : Date.now() - firedMsAgo,
    condition_type: "new_item",
    condition_json: "{}",
    action_type: "notify",
    action_json: "{}",
    created_at: Date.now(),
    last_checked_at: null,
    graph_predicate_json: null,
  };
}

function watchers(rows: ReadonlyArray<Record<string, unknown>>): StubIpcClient {
  return new StubIpcClient({ results: { "watcher.list": { watchers: rows } } });
}

async function frameOf(stub: StubIpcClient, mode: "idle" | "disconnected" = "idle") {
  const r = render(
    <IpcContext.Provider value={ctx(stub)}>
      <WatcherPane mode={mode} />
    </IpcContext.Provider>,
  );
  await new Promise((res) => setTimeout(res, 20));
  return { frame: r.lastFrame() ?? "", unmount: r.unmount };
}

describe("WatcherPane", () => {
  test("renders rows from the { watchers: [...] } envelope the Gateway returns", async () => {
    // The regression guard: with the old `Array.isArray(poll.data)` unwrap this frame
    // read "No watchers configured" regardless of how many watchers existed.
    const { frame, unmount } = await frameOf(watchers([row("w1", "one"), row("w2", "two")]));
    expect(frame).not.toContain("No watchers configured");
    expect(frame).toContain("2 active");
    unmount();
  });

  test("counts active from enabled === 1, not from a non-existent `active` field", async () => {
    const { frame, unmount } = await frameOf(
      watchers([
        row("w1", "one", { enabled: 1, firedMsAgo: 1_000 }),
        row("w2", "two", { enabled: 1 }),
        row("w3", "three", { enabled: 0 }),
      ]),
    );
    expect(frame).toContain("2 active");
    expect(frame).toContain("1 firing");
    unmount();
  });

  test("counts firing from last_fired_at inside the recency window", async () => {
    const { frame, unmount } = await frameOf(
      watchers([
        row("w1", "recent", { firedMsAgo: 60_000 }),
        row("w2", "stale", { firedMsAgo: WATCHER_RECENT_FIRE_WINDOW_MS + 60_000 }),
        row("w3", "never", { firedMsAgo: null }),
      ]),
    );
    expect(frame).toContain("3 active");
    expect(frame).toContain("1 firing");
    expect(frame).toContain("recent");
    expect(frame).not.toContain("stale");
    unmount();
  });

  test("a never-fired watcher is active but not firing", async () => {
    // `last_fired_at: null` must not read as "fired at epoch 0" or as firing.
    const { frame, unmount } = await frameOf(watchers([row("w1", "quiet", { firedMsAgo: null })]));
    expect(frame).toContain("1 active, 0 firing");
    unmount();
  });

  test("lists up to 5 firing watcher names, truncates beyond", async () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      row(`w${String(i)}`, `watcher-${String(i)}`, { firedMsAgo: 1_000 }),
    );
    const { frame, unmount } = await frameOf(watchers(rows));
    expect(frame).toContain("watcher-0");
    expect(frame).toContain("watcher-4");
    expect(frame).not.toContain("watcher-5");
    expect(frame).toContain("…2 more");
    unmount();
  });

  test("BUG-004: shows 'No watchers configured' when the list is empty", async () => {
    const { frame, unmount } = await frameOf(watchers([]));
    expect(frame).toContain("No watchers configured");
    expect(frame).not.toContain("0 active, 0 firing");
    unmount();
  });

  test("falls back to empty on a malformed payload rather than throwing", async () => {
    // A bare array is what the pane used to expect; it is not what the Gateway sends,
    // so it must now be treated as unrecognised rather than silently accepted.
    const { frame, unmount } = await frameOf(
      new StubIpcClient({ results: { "watcher.list": [{ id: "w1", name: "one" }] } }),
    );
    expect(frame).toContain("No watchers configured");
    unmount();
  });

  test("(stale) marker when disconnected", async () => {
    const { frame, unmount } = await frameOf(watchers([]), "disconnected");
    expect(frame).toContain("(stale)");
    unmount();
  });
});
