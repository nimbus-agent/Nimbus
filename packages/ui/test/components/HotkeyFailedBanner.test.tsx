import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const handlers: Handler[] = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, h: Handler) => {
    handlers.push(h);
    return () => {};
  }),
}));

import { listen } from "@tauri-apps/api/event";
import { HotkeyFailedBanner } from "../../src/components/HotkeyFailedBanner";

describe("HotkeyFailedBanner", () => {
  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(listen).mockClear();
  });

  it("subscribes to the tray's hotkey-failed event", async () => {
    render(<HotkeyFailedBanner />);
    await waitFor(() =>
      expect(listen).toHaveBeenCalledWith("tray://hotkey-failed", expect.any(Function)),
    );
  });

  it("falls back to 'Unknown error' when the payload is not a string", async () => {
    render(<HotkeyFailedBanner />);
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    act(() => {
      handlers[0]!({ payload: { code: 1 } });
    });
    expect(await screen.findByText(/Details: Unknown error/)).toBeTruthy();
  });

  it("unlistens a subscription that resolves only after the banner unmounted", async () => {
    // The hand-rolled `listen` this component used to make ran its cleanup while the unlisten
    // function was still null, so a late-resolving subscription was never torn down.
    let resolveListen!: (unlisten: () => void) => void;
    vi.mocked(listen).mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve;
        }),
    );
    const { unmount } = render(<HotkeyFailedBanner />);
    unmount();
    const unlisten = vi.fn();
    resolveListen(unlisten);
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("stays hidden when the subscription itself fails, leaving no unhandled rejection", async () => {
    // A floating rejection here would be reported by vitest as an unhandled error and fail the
    // run; the shared subscription hook owns the rejection instead.
    vi.mocked(listen).mockRejectedValueOnce(new Error("event plugin unavailable"));
    const { container } = render(<HotkeyFailedBanner />);
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe("");
  });

  it("renders nothing until the tray emits hotkey-failed", () => {
    const { container } = render(<HotkeyFailedBanner />);
    expect(container.textContent).toBe("");
  });

  it("renders the conflict message when the event fires", async () => {
    render(<HotkeyFailedBanner />);
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    act(() => {
      handlers[0]!({ payload: "already bound" });
    });
    expect(await screen.findByText(/could not be registered/i)).toBeTruthy();
  });

  it("Dismiss hides the banner", async () => {
    render(<HotkeyFailedBanner />);
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    act(() => {
      handlers[0]!({ payload: "already bound" });
    });
    fireEvent.click(await screen.findByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/could not be registered/i)).toBeNull();
  });
});
