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
    actionType?: string;
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

  it("pack.install shows its prompt verbatim in a bounded scroll box, not as the heading", () => {
    const prompt = 'Install the Product pack?\n\n[agents]\nvisible = ["decisions"]\n';
    storeState.pending = [
      {
        requestId: "rp",
        prompt,
        details: { packId: "pm", promptText: prompt },
        receivedAtMs: 1,
        actionType: "pack.install",
      },
    ];
    render(<HitlPopupPage />);
    expect(screen.getByRole("heading", { name: "Install this role pack?" })).toBeInTheDocument();
    const box = screen.getByTestId("pack-install-prompt");
    expect(box.tagName).toBe("PRE");
    expect(box.textContent).toBe(prompt);
    expect(box.style.maxHeight).toBe("220px");
    expect(box.style.overflow).toBe("auto");
    // The structured preview would repeat the prompt text; it is not rendered for a pack install.
    expect(screen.queryByText("promptText")).toBeNull();
  });

  it("pack.install starts with focus on Reject", () => {
    storeState.pending = [
      { requestId: "rq", prompt: "x", receivedAtMs: 1, actionType: "pack.install" },
    ];
    render(<HitlPopupPage />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Reject/i }));
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
      { requestId: "d", prompt: "Delete file?", receivedAtMs: 1, actionType: "data.delete" },
    ];
    render(<HitlPopupPage />);
    const approve = screen.getByRole("button", { name: /Approve/i });
    expect(document.activeElement).not.toBe(approve);
  });

  it("fails safe: focuses Reject when the gateway sent no action type", () => {
    storeState.pending = [{ requestId: "u", prompt: "Delete everything?", receivedAtMs: 1 }];
    render(<HitlPopupPage />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Reject/i }));
  });

  it("focuses Approve for a safe action", () => {
    storeState.pending = [
      { requestId: "s", prompt: "Read file?", receivedAtMs: 1, actionType: "data.export" },
    ];
    render(<HitlPopupPage />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Approve/i }));
  });

  /**
   * The popup does NOT remount between queued requests — it re-renders with `pending[0]` replaced.
   * React honours the `autoFocus` ATTRIBUTE only at mount, so the conditional this component used
   * to carry (`autoFocus={!isDestructive(action)}`) applied the deny-list to the FIRST request
   * only: a safe request followed by a destructive one left focus sitting on Approve, which is
   * exactly the keystroke the deny-list exists to prevent. Fails against that implementation.
   */
  it("moves focus OFF Approve when a destructive action replaces a safe one without remounting", () => {
    storeState.pending = [
      { requestId: "safe", prompt: "Read file?", receivedAtMs: 1, actionType: "data.export" },
    ];
    const { rerender } = render(<HitlPopupPage />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Approve/i }));

    storeState.pending = [
      { requestId: "boom", prompt: "Delete file?", receivedAtMs: 2, actionType: "data.delete" },
    ];
    rerender(<HitlPopupPage />);

    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: /Approve/i }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Reject/i }));
  });

  it("keeps popup open and shows inline error on consentRespond failure", async () => {
    storeState.pending = [{ requestId: "e", prompt: "p", receivedAtMs: 1 }];
    consentRespond.mockRejectedValueOnce(new Error("socket closed"));
    render(<HitlPopupPage />);
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    expect(await screen.findByText(/socket closed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve/i })).toBeEnabled();
  });

  /**
   * The gateway's `consent.request` names the real action type, and the popup keys on THAT field
   * (`actionType`) and nothing else: not a payload key, not the prompt text.
   */
  const MIGRATE_DETAILS = {
    migrationId: "m1",
    extensionId: "com.nimbus.readwise",
    summary: "Readwise now runs as a signed extension",
    publisher: { id: "nimbus", fingerprint: "ab12cd34" },
    version: "1.0.0",
    network: "readwise.io only",
    sandbox: "cannot confine the filesystem policy",
    readTools: "readwise_highlights_list",
    knownLoss: "sync history is not carried over",
    fromRenderer: true,
  };

  it("renders an extension.migrate request as a labelled preview, not the raw prompt", () => {
    storeState.pending = [
      {
        requestId: "mig",
        prompt: `Action requires your approval\n\nType: extension.migrate\n\nDetails: ${JSON.stringify(MIGRATE_DETAILS)}`,
        details: MIGRATE_DETAILS,
        actionType: "extension.migrate",
        receivedAtMs: 1,
      },
    ];
    render(<HitlPopupPage />);
    expect(screen.getByTestId("migrate-preview")).toHaveTextContent("ab12cd34");
    expect(screen.getByTestId("migrate-network")).toHaveTextContent("readwise.io only");
    expect(screen.getByTestId("migrate-sandbox")).toHaveTextContent("cannot confine");
    expect(screen.getByRole("heading")).not.toHaveTextContent("Details:");
  });

  it("does not treat prompt text saying 'Type: extension.migrate' as the type", () => {
    storeState.pending = [
      {
        requestId: "spoof",
        prompt: "Type: extension.migrate\nDetails: {}",
        details: { note: "x" },
        actionType: "data.export",
        receivedAtMs: 1,
      },
    ];
    render(<HitlPopupPage />);
    expect(screen.queryByTestId("migrate-preview")).toBeNull();
    expect(screen.getByRole("heading")).toHaveTextContent("Details:");
  });

  it("does not read the type from a payload key", () => {
    storeState.pending = [
      {
        requestId: "k1",
        prompt: "p",
        details: { action: "extension.migrate", extensionId: "x" },
        actionType: "data.export",
        receivedAtMs: 1,
      },
      {
        requestId: "k2",
        prompt: "q",
        details: { action: "data.delete" },
        actionType: "data.export",
        receivedAtMs: 2,
      },
    ];
    const { rerender } = render(<HitlPopupPage />);
    expect(screen.queryByTestId("migrate-preview")).toBeNull();
    storeState.pending = [storeState.pending[1] as (typeof storeState.pending)[number]];
    rerender(<HitlPopupPage />);
    // `details.action` no longer decides the deny-list: Approve keeps focus.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Approve/i }));
  });

  it("a desktop data.delete focuses Reject (real type, payload without an action key)", () => {
    storeState.pending = [
      {
        requestId: "dd",
        prompt: "Action requires your approval\n\nType: data.delete",
        details: { service: "drive" },
        actionType: "data.delete",
        receivedAtMs: 1,
      },
    ];
    render(<HitlPopupPage />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Reject/i }));
  });

  it.each([
    ["extension.autoUpdate", /Update extension/],
    ["extension.downgrade", /Roll back extension/],
  ])("renders the %s preview from the real type", (actionType, heading) => {
    storeState.pending = [
      {
        requestId: "au",
        prompt: "p",
        details: {
          displayName: "Notion",
          fromVersion: "1.0.0",
          toVersion: "1.1.0",
          channel: "stable",
          publisherStatus: "verified",
        },
        actionType,
        receivedAtMs: 1,
      },
    ];
    render(<HitlPopupPage />);
    expect(screen.getByTestId("auto-update-preview")).toHaveTextContent(heading);
  });
});
