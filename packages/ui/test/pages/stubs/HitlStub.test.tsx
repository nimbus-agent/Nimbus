import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HitlRequest } from "../../../src/ipc/types";
import { HitlStub } from "../../../src/pages/stubs/HitlStub";
import { useNimbusStore } from "../../../src/store";

const { invokeMock, popup } = vi.hoisted(() => ({
  // Records calls only, with EVERY argument, so `toHaveBeenCalledWith("open_hitl_popup")` also
  // pins that no args object is sent (the Rust command takes nothing from the renderer: its only
  // parameter is Tauri's injected AppHandle). The promise HitlStub receives comes from the plain
  // wrapper in the module mock below: vi.fn attaches settle handlers to every promise it returns
  // (for mock.settledResults), so a rejection returned by the spy itself always counts as handled
  // and a missing `.catch` could never surface as an unhandled rejection.
  invokeMock: vi.fn<(...args: unknown[]) => void>(),
  popup: { failure: null as string | null },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]): Promise<unknown> => {
    invokeMock(...args);
    return popup.failure === null ? Promise.resolve(undefined) : Promise.reject(popup.failure);
  },
}));

function requests(n: number): HitlRequest[] {
  return Array.from({ length: n }, (_, i) => ({
    requestId: `req-${i + 1}`,
    prompt: `Approve action ${i + 1}?`,
    receivedAtMs: 1_000 + i,
  }));
}

const openPopupButton = () => screen.queryByRole("button", { name: "Open popup" });

describe("HitlStub", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    popup.failure = null;
    useNimbusStore.setState({ pending: [] });
  });

  it("titles the page HITL and reports an empty queue without offering the popup", () => {
    render(<HitlStub />);
    expect(screen.getByRole("heading", { level: 1, name: "HITL" })).toBeInTheDocument();
    expect(screen.getByText("No pending actions.")).toBeInTheDocument();
    expect(openPopupButton()).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("uses the singular for exactly one pending action and offers the popup", () => {
    useNimbusStore.setState({ pending: requests(1) });
    render(<HitlStub />);
    expect(screen.getByText("1 pending action.")).toBeInTheDocument();
    expect(screen.queryByText("1 pending actions.")).toBeNull();
    expect(screen.queryByText("No pending actions.")).toBeNull();
    expect(openPopupButton()).toBeInTheDocument();
  });

  it("pluralises the count for more than one pending action", () => {
    useNimbusStore.setState({ pending: requests(3) });
    render(<HitlStub />);
    expect(screen.getByText("3 pending actions.")).toBeInTheDocument();
    expect(screen.queryByText("3 pending action.")).toBeNull();
    expect(openPopupButton()).toBeInTheDocument();
  });

  it("follows the store as requests resolve: the count drops and the button goes away at zero", () => {
    useNimbusStore.setState({ pending: requests(2) });
    render(<HitlStub />);
    expect(screen.getByText("2 pending actions.")).toBeInTheDocument();

    act(() => {
      useNimbusStore.getState().resolve("req-1", true);
    });
    expect(screen.getByText("1 pending action.")).toBeInTheDocument();
    expect(openPopupButton()).toBeInTheDocument();

    act(() => {
      useNimbusStore.getState().resolve("req-2", false);
    });
    expect(screen.getByText("No pending actions.")).toBeInTheDocument();
    expect(openPopupButton()).toBeNull();
  });

  it("asks the shell to open the HITL popup when the button is pressed", async () => {
    useNimbusStore.setState({ pending: requests(1) });
    const user = userEvent.setup();
    render(<HitlStub />);

    await user.click(screen.getByRole("button", { name: "Open popup" }));

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("open_hitl_popup");
  });

  it("swallows a failed popup open instead of leaking an unhandled rejection", async () => {
    // `open_hitl_popup` returns `Result<(), String>` on the Rust side, so a failure reaches the
    // renderer as a rejected string. Without the `.catch`, vitest reports the floating rejection
    // as an unhandled error and fails the run (see the module mock for why the promise must not
    // come from the spy).
    popup.failure = "popup window unavailable";
    useNimbusStore.setState({ pending: requests(1) });
    const user = userEvent.setup();
    render(<HitlStub />);

    await user.click(screen.getByRole("button", { name: "Open popup" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("open_hitl_popup");
    // The page is untouched by the failure: same count, button still offered.
    expect(screen.getByText("1 pending action.")).toBeInTheDocument();
    expect(openPopupButton()).toBeInTheDocument();
  });
});
