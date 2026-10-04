import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ipc/client");

import { type AvailableUpdateUi, PendingUpdates } from "../../src/components/PendingUpdates";
import { callMock } from "../../src/ipc/__mocks__/client";
import { useNimbusStore } from "../../src/store";

function sample(overrides: Partial<AvailableUpdateUi> = {}): AvailableUpdateUi {
  return {
    id: "com.x.a",
    displayName: "X",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    channel: "stable",
    publisherStatus: "verified",
    verificationStatus: "verified",
    ...overrides,
  };
}

function stub(updates: unknown, apply: () => Promise<unknown>): void {
  callMock.mockImplementation(async (method: string) => {
    if (method === "extension.checkForUpdates") return updates;
    if (method === "extension.update") return apply();
    throw new Error(`unexpected ${method}`);
  });
}

function checkCalls(): number {
  return callMock.mock.calls.filter(([m]) => m === "extension.checkForUpdates").length;
}

async function clickUpdate(): Promise<void> {
  const btn = await screen.findByTestId("update-button-com.x.a");
  await act(async () => {
    fireEvent.click(btn);
  });
}

beforeEach(() => {
  callMock.mockReset();
  useNimbusStore.setState({ connectionState: "connected" });
});

afterEach(() => {
  cleanup();
});

describe("PendingUpdates — applying", () => {
  it("reports a successful update in green and refetches the list", async () => {
    stub([sample()], async () => ({ applied: true }));
    render(<PendingUpdates offline={false} />);
    await clickUpdate();

    const result = screen.getByTestId("apply-result-com.x.a");
    expect(result).toHaveTextContent("Updated com.x.a");
    expect(result.className).toContain("text-green-700");
    expect(callMock).toHaveBeenCalledWith("extension.update", {
      id: "com.x.a",
      toVersion: "1.1.0",
    });
    await waitFor(() => expect(checkCalls()).toBe(2));
  });

  it("reports a refused update in red with its reason and hint", async () => {
    stub([sample()], async () => ({
      applied: false,
      reason: "downgrade_blocked",
      hint: "pin the previous version",
    }));
    render(<PendingUpdates offline={false} />);
    await clickUpdate();

    const result = screen.getByTestId("apply-result-com.x.a");
    expect(result.textContent).toBe("Update failed: downgrade_blocked — pin the previous version");
    expect(result.className).toContain("text-red-600");
    expect(result.className).not.toContain("text-green-700");
  });

  it("omits the hint separator when the refusal carries no hint", async () => {
    stub([sample()], async () => ({ applied: false, reason: "not_found" }));
    render(<PendingUpdates offline={false} />);
    await clickUpdate();
    expect(screen.getByTestId("apply-result-com.x.a").textContent).toBe("Update failed: not_found");
  });

  it("shows a transport error instead of a result, and stringifies non-Error rejections", async () => {
    const apply = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("rpc timeout"))
      .mockRejectedValueOnce("E_UPDATE");
    stub([sample()], apply);
    render(<PendingUpdates offline={false} />);
    await clickUpdate();
    expect(screen.getByTestId("apply-error")).toHaveTextContent("rpc timeout");
    expect(screen.queryByTestId("apply-result-com.x.a")).toBeNull();

    await clickUpdate();
    expect(screen.getByTestId("apply-error")).toHaveTextContent("E_UPDATE");
    expect(screen.getByTestId("apply-error")).not.toHaveTextContent("rpc timeout");
    // A failed apply is not followed by a refetch.
    expect(checkCalls()).toBe(1);
  });

  it("clears the previous attempt's outcome as soon as the next attempt starts", async () => {
    const apply = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("rpc timeout"))
      .mockResolvedValueOnce({ applied: true })
      .mockRejectedValueOnce(new Error("socket closed"));
    stub([sample()], apply);
    render(<PendingUpdates offline={false} />);

    await clickUpdate();
    expect(screen.getByTestId("apply-error")).toHaveTextContent("rpc timeout");

    // A successful retry leaves the result alone on screen: no stale (or empty) error paragraph.
    await clickUpdate();
    expect(screen.getByTestId("apply-result-com.x.a")).toHaveTextContent("Updated com.x.a");
    expect(screen.queryByTestId("apply-error")).toBeNull();

    // A failed retry leaves the error alone on screen: the earlier success is not kept.
    await clickUpdate();
    expect(screen.getByTestId("apply-error")).toHaveTextContent("socket closed");
    expect(screen.queryByTestId("apply-result-com.x.a")).toBeNull();
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it("labels the row Updating… and disables it while the update is in flight", async () => {
    let finish: (v: unknown) => void = () => {};
    stub(
      [sample()],
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    render(<PendingUpdates offline={false} />);
    await clickUpdate();
    const btn = screen.getByTestId("update-button-com.x.a");
    expect(btn).toHaveTextContent("Updating…");
    expect(btn).toBeDisabled();

    await act(async () => {
      finish({ applied: true });
    });
    expect(btn).toHaveTextContent("Update");
    expect(btn).not.toBeDisabled();
  });
});

describe("PendingUpdates — listing", () => {
  it("styles an unverified publisher amber and a verified one green", async () => {
    stub([sample(), sample({ id: "com.x.b", publisherStatus: "unverified" })], async () => ({
      applied: true,
    }));
    render(<PendingUpdates offline={false} />);
    await screen.findByTestId("pending-update-row-com.x.b");
    expect(screen.getByText("publisher: unverified").className).toContain("text-amber-700");
    expect(screen.getByText("publisher: verified").className).toContain("text-green-700");
  });

  it("labels a verified row with its version pair, an accessible action and no warning badges", async () => {
    stub([sample()], async () => ({ applied: true }));
    render(<PendingUpdates offline={false} />);
    const row = await screen.findByTestId("pending-update-row-com.x.a");

    expect(row.querySelector(".font-mono")?.textContent).toBe("X 1.0.0 → 1.1.0");
    expect(screen.getByRole("button", { name: "Update com.x.a to 1.1.0" })).toBe(
      screen.getByTestId("update-button-com.x.a"),
    );
    // The needs-sync / signature-failed badges belong to unverified rows only.
    expect(screen.queryByTestId("needs-sync-com.x.a")).toBeNull();
    expect(screen.queryByTestId("signature-failed-com.x.a")).toBeNull();
  });

  it("hides an already-loaded list as soon as the panel goes offline", async () => {
    stub([sample()], async () => ({ applied: true }));
    const { container, rerender } = render(<PendingUpdates offline={false} />);
    await screen.findByTestId("pending-update-row-com.x.a");

    // The fetched rows are still held by the query; only the offline guard keeps them off screen.
    rerender(<PendingUpdates offline={true} />);
    expect(container).toBeEmptyDOMElement();
    expect(checkCalls()).toBe(1);
  });

  it("renders nothing when the update check fails", async () => {
    callMock.mockRejectedValue(new Error("registry unreachable"));
    const { container } = render(<PendingUpdates offline={false} />);
    await waitFor(() => expect(checkCalls()).toBe(1));
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("hides a previously loaded list once a later check fails", async () => {
    let checks = 0;
    callMock.mockImplementation(async (method: string) => {
      if (method === "extension.update") return { applied: true };
      if (method !== "extension.checkForUpdates") throw new Error(`unexpected ${method}`);
      checks += 1;
      if (checks === 1) return [sample()];
      throw new Error("registry unreachable");
    });
    const { container } = render(<PendingUpdates offline={false} />);
    // A successful apply triggers the refetch; that second check fails while the first check's
    // rows are still in hand, so only the error guard keeps the stale list off screen.
    await clickUpdate();
    await waitFor(() => expect(checkCalls()).toBe(2));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByTestId("pending-update-row-com.x.a")).toBeNull();
  });

  it("treats a non-array response as having no updates", async () => {
    callMock.mockResolvedValue({ updates: [sample()] });
    const { container } = render(<PendingUpdates offline={false} />);
    await waitFor(() => expect(checkCalls()).toBe(1));
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("does not poll at all while offline", async () => {
    callMock.mockResolvedValue([sample()]);
    const { container } = render(<PendingUpdates offline={true} />);
    await act(async () => {});
    expect(checkCalls()).toBe(0);
    expect(container).toBeEmptyDOMElement();
  });
});
