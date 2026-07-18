import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(() => {
  callMock.mockReset();
  useNimbusStore.setState({ connectionState: "connected" });
});

describe("PendingUpdates", () => {
  it("renders nothing when offline", () => {
    callMock.mockResolvedValue([sample()]);
    render(<PendingUpdates offline={true} />);
    expect(screen.queryByTestId("pending-updates")).toBeNull();
  });

  it("renders nothing when cache is empty", async () => {
    callMock.mockResolvedValue([]);
    render(<PendingUpdates offline={false} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId("pending-updates")).toBeNull();
  });

  it("renders one row per cache entry with version pair + badges", async () => {
    callMock.mockResolvedValue([sample()]);
    render(<PendingUpdates offline={false} />);
    expect(await screen.findByTestId("pending-update-row-com.x.a")).toBeInTheDocument();
    expect(screen.getByText(/X/)).toBeInTheDocument();
    expect(screen.getByText(/1\.0\.0 → 1\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText("stable")).toBeInTheDocument();
    expect(screen.getByText(/publisher: verified/)).toBeInTheDocument();
  });

  it("fires extension.update on click when verified", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "extension.checkForUpdates") return [sample()];
      if (method === "extension.update") return { applied: true };
      throw new Error(`unexpected ${method}`);
    });
    render(<PendingUpdates offline={false} />);
    const btn = await screen.findByTestId("update-button-com.x.a");
    await userEvent.click(btn);
    await waitFor(() => {
      const calls = callMock.mock.calls.map((c) => c[0]);
      expect(calls).toContain("extension.update");
    });
  });

  it("disables Update + renders needs_sync badge when verification needs sync", async () => {
    callMock.mockResolvedValue([sample({ verificationStatus: "needs_sync" })]);
    render(<PendingUpdates offline={false} />);
    expect(await screen.findByTestId("needs-sync-com.x.a")).toBeInTheDocument();
    expect(screen.getByTestId("update-button-com.x.a")).toBeDisabled();
  });

  it("disables Update + renders signature_failed badge", async () => {
    callMock.mockResolvedValue([sample({ verificationStatus: "signature_failed" })]);
    render(<PendingUpdates offline={false} />);
    expect(await screen.findByTestId("signature-failed-com.x.a")).toBeInTheDocument();
    expect(screen.getByTestId("update-button-com.x.a")).toBeDisabled();
  });

  it("does not fire extension.update for an unverified row even if clicked programmatically", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "extension.checkForUpdates")
        return [sample({ verificationStatus: "needs_sync" })];
      throw new Error(`unexpected ${method}`);
    });
    render(<PendingUpdates offline={false} />);
    await screen.findByTestId("update-button-com.x.a");
    await userEvent.click(screen.getByTestId("update-button-com.x.a"));
    const updateCalls = callMock.mock.calls.filter((c) => c[0] === "extension.update");
    expect(updateCalls).toHaveLength(0);
  });
});
