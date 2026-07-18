import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/ipc/client");

import { PullDialog } from "../../../../src/components/settings/model/PullDialog";
import {
  llmCancelPullMock,
  llmGetStatusMock,
  llmPullModelMock,
  subscribeMock,
} from "../../../../src/ipc/__mocks__/client";
import { useNimbusStore } from "../../../../src/store";

beforeEach(() => {
  localStorage.clear();
  llmGetStatusMock.mockReset();
  llmPullModelMock.mockReset();
  llmCancelPullMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockResolvedValue(() => {});
  useNimbusStore.setState({
    installedModels: [],
    activePullId: null,
    pullProgress: {},
    pullStalled: false,
    routerStatus: null,
    loadedKeys: {},
    connectionState: "connected",
  });
});

function captureSubscription(): {
  getCaptured: () => ((n: { method: string; params: unknown }) => void) | null;
} {
  let captured: ((n: { method: string; params: unknown }) => void) | null = null;
  subscribeMock.mockImplementation(async (handler) => {
    captured = handler;
    return () => {};
  });
  return { getCaptured: () => captured };
}

async function renderAndStartPull(): Promise<void> {
  render(<PullDialog open onClose={() => {}} />);
  await screen.findByLabelText(/model name/i);
  await userEvent.type(screen.getByLabelText(/model name/i), "gemma:2b");
  await userEvent.click(screen.getByRole("button", { name: /pull/i }));
  await waitFor(() => expect(llmPullModelMock).toHaveBeenCalledWith("ollama", "gemma:2b"));
}

describe("PullDialog", () => {
  it("hides the llama.cpp radio when availability reports it unavailable", async () => {
    llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true, llamacpp: false } });
    render(<PullDialog open onClose={() => {}} />);
    await screen.findByLabelText(/ollama/i);
    expect(screen.queryByLabelText(/llama\.cpp/i)).not.toBeInTheDocument();
  });

  it("shows both providers when both are available", async () => {
    llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true, llamacpp: true } });
    render(<PullDialog open onClose={() => {}} />);
    await screen.findByLabelText(/ollama/i);
    expect(screen.getByLabelText(/llama\.cpp/i)).toBeInTheDocument();
  });

  it("submitting calls llmPullModel, then pullProgress notifications update the bar", async () => {
    llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true, llamacpp: true } });
    llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_abc" });
    const { getCaptured } = captureSubscription();
    await renderAndStartPull();
    getCaptured()?.({
      method: "llm.pullProgress",
      params: {
        pullId: "pull_abc",
        provider: "ollama",
        modelName: "gemma:2b",
        status: "downloading",
        completedBytes: 500,
        totalBytes: 1000,
      },
    });
    await waitFor(() => {
      const bar = screen.getByRole("progressbar");
      expect(bar).toHaveAttribute("aria-valuenow", "50");
    });
  });

  it("cancel during an active pull calls llmCancelPull with the pullId", async () => {
    llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true, llamacpp: true } });
    llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_abc" });
    llmCancelPullMock.mockResolvedValueOnce({ cancelled: true });
    await renderAndStartPull();
    await screen.findByRole("button", { name: /cancel pull/i });
    await userEvent.click(screen.getByRole("button", { name: /cancel pull/i }));
    await waitFor(() => expect(llmCancelPullMock).toHaveBeenCalledWith("pull_abc"));
  });

  it("15 s without a pullProgress chunk flips the row to amber 'Connecting…'", async () => {
    vi.useFakeTimers();
    try {
      llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true } });
      llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_abc" });
      let captured: ((n: { method: string; params: unknown }) => void) | null = null;
      subscribeMock.mockImplementation(async (handler) => {
        captured = handler;
        return () => {};
      });
      render(<PullDialog open onClose={() => {}} />);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await screen.findByLabelText(/model name/i);
      await user.type(screen.getByLabelText(/model name/i), "gemma:2b");
      await user.click(screen.getByRole("button", { name: /pull/i }));
      await waitFor(() => expect(llmPullModelMock).toHaveBeenCalledWith("ollama", "gemma:2b"));
      vi.advanceTimersByTime(15_000);
      expect(await screen.findByText(/connecting…/i)).toBeInTheDocument();
      captured?.({
        method: "llm.pullProgress",
        params: {
          pullId: "pull_abc",
          provider: "ollama",
          modelName: "gemma:2b",
          status: "downloading",
          completedBytes: 100,
          totalBytes: 1000,
        },
      });
      await waitFor(() => expect(screen.queryByText(/connecting…/i)).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-attach with a persisted activePullId arms the stall timer without waiting for a chunk", async () => {
    vi.useFakeTimers();
    try {
      useNimbusStore.setState({
        activePullId: "pull_abc",
        pullProgress: {
          pull_abc: {
            pullId: "pull_abc",
            provider: "ollama",
            modelName: "gemma:2b",
            status: "downloading",
            completedBytes: 100,
            totalBytes: 1000,
          },
        },
      });
      llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true } });
      render(<PullDialog open onClose={() => {}} />);
      await screen.findByLabelText(/model name/i);
      expect(screen.queryByText(/connecting…/i)).not.toBeInTheDocument();
      vi.advanceTimersByTime(15_000);
      expect(await screen.findByText(/connecting…/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("llm.pullFailed clears the pullId and shows an error toast-style message", async () => {
    llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true } });
    llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_abc" });
    const { getCaptured } = captureSubscription();
    await renderAndStartPull();
    getCaptured()?.({
      method: "llm.pullFailed",
      params: {
        pullId: "pull_abc",
        provider: "ollama",
        modelName: "gemma:2b",
        error: "disk full",
      },
    });
    await waitFor(() => {
      expect(screen.getByText(/disk full/i)).toBeInTheDocument();
      expect(useNimbusStore.getState().activePullId).toBeNull();
    });
  });
});
