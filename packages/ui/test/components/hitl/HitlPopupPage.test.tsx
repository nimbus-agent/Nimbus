import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const consentRespond = vi.fn();
vi.mock("../../../src/ipc/client", () => ({
  createIpcClient: () => ({ consentRespond }),
}));

const storeState: {
  pending: Array<{
    requestId: string;
    prompt: string;
    details?: Record<string, unknown>;
    receivedAtMs: number;
    action?: string;
  }>;
  resolve: (id: string, ok: boolean) => void;
} = { pending: [], resolve: vi.fn() };

vi.mock("../../../src/store", () => ({
  useNimbusStore: (sel: (s: typeof storeState) => unknown) => sel(storeState),
}));

import { HitlPopupPage } from "../../../src/components/hitl/HitlPopupPage";

beforeEach(() => {
  invoke.mockReset();
  consentRespond.mockReset();
});

describe("HitlPopupPage", () => {
  it("renders 'No pending requests' when queue is empty", () => {
    storeState.pending = [];
    render(<HitlPopupPage />);
    expect(screen.getByText(/No pending requests/i)).toBeInTheDocument();
  });

  it("invokes close_hitl_popup after 500 ms when pending queue is empty", async () => {
    vi.useFakeTimers();
    storeState.pending = [];
    invoke.mockResolvedValue(undefined);
    render(<HitlPopupPage />);
    expect(invoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledWith("close_hitl_popup");
    vi.useRealTimers();
  });

  it("renders the head-of-queue prompt", () => {
    storeState.pending = [{ requestId: "r1", prompt: "Send message?", receivedAtMs: Date.now() }];
    render(<HitlPopupPage />);
    expect(screen.getByRole("heading", { name: /Send message\?/ })).toBeInTheDocument();
  });

  it("Approve dispatches consentRespond(id, true)", async () => {
    storeState.pending = [{ requestId: "r2", prompt: "p", receivedAtMs: 1 }];
    consentRespond.mockResolvedValue(undefined);
    render(<HitlPopupPage />);
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    await waitFor(() => expect(consentRespond).toHaveBeenCalledWith("r2", true));
  });

  it("Reject dispatches consentRespond(id, false)", async () => {
    storeState.pending = [{ requestId: "r3", prompt: "p", receivedAtMs: 1 }];
    consentRespond.mockResolvedValue(undefined);
    render(<HitlPopupPage />);
    fireEvent.click(screen.getByRole("button", { name: /Reject/i }));
    await waitFor(() => expect(consentRespond).toHaveBeenCalledWith("r3", false));
  });

  it("shows +N more pending when queue length > 1", () => {
    storeState.pending = [
      { requestId: "a", prompt: "p", receivedAtMs: 1 },
      { requestId: "b", prompt: "q", receivedAtMs: 2 },
      { requestId: "c", prompt: "r", receivedAtMs: 3 },
    ];
    render(<HitlPopupPage />);
    expect(screen.getByText(/\+2 more pending/)).toBeInTheDocument();
  });

  it("does NOT autoFocus Approve for destructive actions", () => {
    storeState.pending = [
      { requestId: "d", prompt: "Delete file?", receivedAtMs: 1, action: "file.delete" },
    ];
    render(<HitlPopupPage />);
    const approve = screen.getByRole("button", { name: /Approve/i });
    expect(document.activeElement).not.toBe(approve);
  });

  it("keeps popup open and shows inline error on consentRespond failure", async () => {
    storeState.pending = [{ requestId: "e", prompt: "p", receivedAtMs: 1 }];
    consentRespond.mockRejectedValueOnce(new Error("socket closed"));
    render(<HitlPopupPage />);
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    expect(await screen.findByText(/socket closed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve/i })).toBeEnabled();
  });
});
