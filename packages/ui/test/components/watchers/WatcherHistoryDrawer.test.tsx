import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const history = vi.fn<(id: string, limit: number) => Promise<unknown>>();
vi.mock("../../../src/ipc/client", () => ({
  createIpcClient: () => ({
    watcherListHistory: (id: string, limit: number) => history(id, limit),
  }),
}));

import { WatcherHistoryDrawer } from "../../../src/components/watchers/WatcherHistoryDrawer";

function mount(onClose = vi.fn()) {
  render(<WatcherHistoryDrawer watcherId="w1" watcherName="Disk" onClose={onClose} />);
  return onClose;
}

describe("WatcherHistoryDrawer", () => {
  beforeEach(() => {
    history.mockReset();
  });

  it("asks for the last 50 fires of its watcher and shows a loading line first", async () => {
    history.mockReturnValue(new Promise(() => undefined));
    mount();
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(history).toHaveBeenCalledWith("w1", 50);
    expect(screen.getByRole("region", { name: "History for Disk" })).toBeTruthy();
  });

  it("lists each fire with its condition snapshot", async () => {
    history.mockResolvedValue({
      events: [
        { firedAt: 1_000, conditionSnapshot: "disk > 90%", actionResult: "ok" },
        { firedAt: 2_000, conditionSnapshot: "disk > 95%", actionResult: "ok" },
      ],
    });
    mount();
    expect(await screen.findByText("disk > 90%")).toBeTruthy();
    expect(screen.getByText("disk > 95%")).toBeTruthy();
    expect(screen.queryByText("No fires yet.")).toBeNull();
  });

  it("says so when the watcher never fired", async () => {
    history.mockResolvedValue({ events: [] });
    mount();
    expect(await screen.findByText("No fires yet.")).toBeTruthy();
  });

  it("shows an Error's message, or a non-Error's string form, and no loading line", async () => {
    history.mockRejectedValueOnce(new Error("ipc down"));
    const { unmount } = render(
      <WatcherHistoryDrawer watcherId="w1" watcherName="Disk" onClose={() => undefined} />,
    );
    expect(await screen.findByText("ipc down")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    unmount();
    history.mockRejectedValueOnce("plain text failure");
    mount();
    expect(await screen.findByText("plain text failure")).toBeTruthy();
  });

  it("Close calls onClose", async () => {
    history.mockResolvedValue({ events: [] });
    const onClose = mount();
    await waitFor(() => expect(screen.getByText("No fires yet.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores an answer that arrives after unmount", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    history.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = render(
      <WatcherHistoryDrawer watcherId="w1" watcherName="Disk" onClose={() => undefined} />,
    );
    unmount();
    resolve({ events: [{ firedAt: 1, conditionSnapshot: "late", actionResult: "ok" }] });
    await Promise.resolve();
    expect(screen.queryByText("late")).toBeNull();
  });
});
