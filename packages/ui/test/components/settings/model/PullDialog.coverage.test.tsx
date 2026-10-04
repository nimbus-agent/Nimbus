import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/ipc/client");

import { PullDialog } from "../../../../src/components/settings/model/PullDialog";
import {
  llmCancelPullMock,
  llmGetStatusMock,
  llmPullModelMock,
  subscribeMock,
} from "../../../../src/ipc/__mocks__/client";
import { useNimbusStore } from "../../../../src/store";

type Handler = (n: { method: string; params: unknown }) => void;

let captured: Handler | null = null;

function emit(method: string, params: unknown): void {
  // Throw rather than no-op: a silently dropped notification would make every "ignores X" test pass
  // without the dialog ever seeing X.
  const handler = captured;
  if (handler === null) throw new Error("the dialog has not subscribed to notifications");
  act(() => handler({ method, params }));
}

function progress(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullId: "pull_1",
    provider: "ollama",
    modelName: "gemma:2b",
    status: "downloading",
    completedBytes: 10,
    totalBytes: 100,
    ...overrides,
  };
}

async function openWith(available: Record<string, boolean>): Promise<void> {
  llmGetStatusMock.mockResolvedValueOnce({ available });
  render(<PullDialog open onClose={() => {}} />);
  await waitFor(() => expect(llmGetStatusMock).toHaveBeenCalledTimes(1));
  await act(async () => {});
}

async function startPull(model = "gemma:2b"): Promise<void> {
  fireEvent.change(screen.getByLabelText("Model name"), { target: { value: model } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
  });
}

beforeEach(() => {
  captured = null;
  llmGetStatusMock.mockReset();
  llmPullModelMock.mockReset();
  llmCancelPullMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockImplementation(async (handler: Handler) => {
    captured = handler;
    return () => {};
  });
  useNimbusStore.setState({
    activePullId: null,
    pullProgress: {},
    pullStalled: false,
    connectionState: "connected",
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PullDialog — closed", () => {
  it("renders nothing and neither queries status nor subscribes", () => {
    const { container } = render(<PullDialog open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(llmGetStatusMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();
  });
});

describe("PullDialog — opening", () => {
  // ModelPanel keeps the dialog mounted and flips `open`, so this is the production path.
  it("probes the runtimes and subscribes once a mounted, closed dialog is opened", async () => {
    llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true, llamacpp: true } });
    const { rerender } = render(<PullDialog open={false} onClose={() => {}} />);
    expect(llmGetStatusMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();

    rerender(<PullDialog open onClose={() => {}} />);
    expect(await screen.findByLabelText("llama.cpp")).toBeInTheDocument();
    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    emit("llm.pullProgress", progress({ pullId: "pull_elsewhere" }));
    expect(useNimbusStore.getState().pullProgress["pull_elsewhere"]).toMatchObject({
      status: "downloading",
    });
  });
});

describe("PullDialog — provider selection", () => {
  it("keeps Ollama as the provider when neither runtime reports itself available", async () => {
    llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_1" });
    await openWith({ ollama: false, llamacpp: false });
    expect(screen.queryByRole("radio")).toBeNull();
    await startPull("gemma:2b");
    expect(llmPullModelMock).toHaveBeenCalledWith("ollama", "gemma:2b");
  });

  it("offers both providers when the status probe fails", async () => {
    llmGetStatusMock.mockRejectedValueOnce(new Error("router offline"));
    render(<PullDialog open onClose={() => {}} />);
    expect(await screen.findByLabelText("Ollama")).toBeChecked();
    expect(screen.getByLabelText("llama.cpp")).not.toBeChecked();
  });

  it("preselects llama.cpp when only llama.cpp is available", async () => {
    llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_1" });
    await openWith({ ollama: false, llamacpp: true });
    expect(screen.queryByLabelText("Ollama")).toBeNull();
    expect(screen.getByLabelText("llama.cpp")).toBeChecked();
    await startPull("llama3:8b");
    expect(llmPullModelMock).toHaveBeenCalledWith("llamacpp", "llama3:8b");
  });

  it("keeps Ollama selected when both are available", async () => {
    await openWith({ ollama: true, llamacpp: true });
    expect(screen.getByLabelText("Ollama")).toBeChecked();
    expect(screen.getByLabelText("llama.cpp")).not.toBeChecked();
  });

  it("pulls through whichever provider radio was picked last", async () => {
    llmPullModelMock.mockResolvedValue({ pullId: "pull_1" });
    await openWith({ ollama: true, llamacpp: true });

    fireEvent.click(screen.getByLabelText("llama.cpp"));
    expect(screen.getByLabelText("llama.cpp")).toBeChecked();
    fireEvent.click(screen.getByLabelText("Ollama"));
    expect(screen.getByLabelText("Ollama")).toBeChecked();
    fireEvent.click(screen.getByLabelText("llama.cpp"));

    await startPull("  qwen:7b  ");
    expect(llmPullModelMock).toHaveBeenCalledTimes(1);
    expect(llmPullModelMock).toHaveBeenCalledWith("llamacpp", "qwen:7b");
  });

  it("keeps Pull disabled for a whitespace-only model name", async () => {
    await openWith({ ollama: true });
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "gemma:2b" } });
    expect(screen.getByRole("button", { name: "Pull" })).not.toBeDisabled();
  });
});

describe("PullDialog — pull lifecycle", () => {
  it("disables Pull while the pull request is in flight", async () => {
    let finish: (v: { pullId: string }) => void = () => {};
    llmPullModelMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    await openWith({ ollama: true });
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "gemma:2b" } });
    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();

    await act(async () => {
      finish({ pullId: "pull_1" });
    });
    expect(screen.getByRole("button", { name: "Cancel pull" })).toBeInTheDocument();
  });

  it("clears the previous request error as soon as the next pull starts", async () => {
    let finish: (v: { pullId: string }) => void = () => {};
    llmPullModelMock
      .mockRejectedValueOnce(new Error("model not found in registry"))
      .mockReturnValueOnce(
        new Promise((r) => {
          finish = r;
        }),
      );
    await openWith({ ollama: true });
    await startPull("nope:1b");
    expect(screen.getByText("model not found in registry")).toBeInTheDocument();

    // Assert while the retry is still in flight: its success would not prove the error was cleared.
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "gemma:2b" } });
    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    expect(screen.queryByText("model not found in registry")).toBeNull();
    await act(async () => {
      finish({ pullId: "pull_2" });
    });
  });

  it("clears a failed pull's progress row and its stalled flag", async () => {
    vi.useFakeTimers();
    llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_1" });
    await openWith({ ollama: true });
    await startPull();
    emit("llm.pullProgress", progress());
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    // Premise: the pull really is marked stalled before it fails.
    expect(useNimbusStore.getState().pullStalled).toBe(true);

    emit("llm.pullFailed", {
      pullId: "pull_1",
      provider: "ollama",
      modelName: "gemma:2b",
      error: "disk full",
    });
    expect(screen.getByText("disk full")).toBeInTheDocument();
    expect(useNimbusStore.getState().pullProgress["pull_1"]).toBeUndefined();
    expect(useNimbusStore.getState().pullStalled).toBe(false);
  });

  it("shows the request error and leaves the dialog ready to retry", async () => {
    llmPullModelMock.mockRejectedValueOnce(new Error("model not found in registry"));
    await openWith({ ollama: true });
    await startPull("nope:1b");

    expect(screen.getByText("model not found in registry")).toBeInTheDocument();
    expect(useNimbusStore.getState().activePullId).toBeNull();
    expect(screen.getByRole("button", { name: "Pull" })).not.toBeDisabled();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("clears the active pull and its progress row on llm.pullCompleted", async () => {
    llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_1" });
    await openWith({ ollama: true });
    await startPull();
    emit("llm.pullProgress", progress());
    expect(useNimbusStore.getState().pullProgress["pull_1"]).toMatchObject({
      status: "downloading",
      completedBytes: 10,
      totalBytes: 100,
    });
    expect(screen.getByText("downloading · 10%")).toBeInTheDocument();

    emit("llm.pullCompleted", { pullId: "pull_1", provider: "ollama", modelName: "gemma:2b" });

    expect(useNimbusStore.getState().activePullId).toBeNull();
    expect(useNimbusStore.getState().pullProgress["pull_1"]).toBeUndefined();
    expect(useNimbusStore.getState().pullStalled).toBe(false);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("button", { name: "Pull" })).toBeInTheDocument();
    expect(screen.queryByText(/Pull failed/)).toBeNull();
  });

  it("falls back to a generic message when llm.pullFailed carries no error", async () => {
    llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_1" });
    await openWith({ ollama: true });
    await startPull();
    emit("llm.pullFailed", { pullId: "pull_1", provider: "ollama", modelName: "gemma:2b" });
    expect(screen.getByText("Pull failed")).toBeInTheDocument();
    expect(useNimbusStore.getState().activePullId).toBeNull();
  });

  it("ignores notifications that are not pull lifecycle events", async () => {
    llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_1" });
    await openWith({ ollama: true });
    await startPull();
    emit("llm.modelLoaded", { pullId: "pull_1", provider: "ollama", modelName: "gemma:2b" });
    expect(useNimbusStore.getState().activePullId).toBe("pull_1");
    expect(screen.getByRole("button", { name: "Cancel pull" })).toBeInTheDocument();
  });

  it.each([
    ["unknown completed bytes", { completedBytes: undefined }, "0"],
    ["unknown total size", { totalBytes: undefined }, "0"],
    ["a zero total size", { totalBytes: 0 }, "0"],
    ["over-reported bytes", { completedBytes: 250, totalBytes: 100 }, "100"],
    ["a partial download that rounds down", { completedBytes: 1, totalBytes: 3 }, "33"],
    ["a partial download that rounds up", { completedBytes: 2, totalBytes: 3 }, "67"],
  ])("reports the percentage for %s", async (_label, overrides, expected) => {
    llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_1" });
    await openWith({ ollama: true });
    await startPull();
    emit("llm.pullProgress", progress(overrides));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", expected);
    expect(screen.getByText(`downloading · ${expected}%`)).toBeInTheDocument();
  });

  it("records progress for a pull this dialog did not start without showing a bar", async () => {
    await openWith({ ollama: true });
    emit("llm.pullProgress", progress({ pullId: "pull_elsewhere" }));
    expect(useNimbusStore.getState().pullProgress["pull_elsewhere"]).toMatchObject({
      status: "downloading",
    });
    expect(useNimbusStore.getState().activePullId).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("treats a completion for an unknown pull, before any progress arrived, as a no-op", async () => {
    await openWith({ ollama: true });
    // No progress has armed the stall watchdog yet, so the completion has no timer to clear.
    emit("llm.pullCompleted", { pullId: "pull_elsewhere", provider: "ollama", modelName: "x" });
    expect(useNimbusStore.getState().activePullId).toBeNull();
    expect(useNimbusStore.getState().pullProgress).toEqual({});
    expect(screen.getByRole("button", { name: "Pull" })).toBeInTheDocument();
    expect(screen.queryByText("Pull failed")).toBeNull();
  });

  it("clears the progress row of a completed pull this dialog did not start", async () => {
    await openWith({ ollama: true });
    emit("llm.pullProgress", progress({ pullId: "pull_elsewhere" }));
    expect(useNimbusStore.getState().pullProgress["pull_elsewhere"]).toMatchObject({
      pullId: "pull_elsewhere",
    });

    emit("llm.pullCompleted", { pullId: "pull_elsewhere", provider: "ollama", modelName: "x" });
    expect(useNimbusStore.getState().pullProgress["pull_elsewhere"]).toBeUndefined();
    expect(useNimbusStore.getState().activePullId).toBeNull();
    expect(screen.getByRole("button", { name: "Pull" })).toBeInTheDocument();
    expect(screen.queryByText("Pull failed")).toBeNull();
  });

  it("surfaces a failure for a pull this dialog did not start", async () => {
    await openWith({ ollama: true });
    emit("llm.pullFailed", {
      pullId: "pull_elsewhere",
      provider: "ollama",
      modelName: "x",
      error: "registry unreachable",
    });
    expect(screen.getByText("registry unreachable")).toBeInTheDocument();
    expect(screen.queryByText("Pull failed")).toBeNull();
  });

  it("restarts the 15 s stall watchdog on every progress chunk", async () => {
    vi.useFakeTimers();
    llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_1" });
    await openWith({ ollama: true });
    await startPull();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    emit("llm.pullProgress", progress());

    // 20 s after the pull started, but only 10 s after the chunk: not stalled yet.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(useNimbusStore.getState().pullStalled).toBe(false);
    expect(screen.getByText("downloading · 10%")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(useNimbusStore.getState().pullStalled).toBe(true);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(screen.queryByText("downloading · 10%")).toBeNull();
  });

  it("does not run the stall watchdog while no pull is active", async () => {
    vi.useFakeTimers();
    await openWith({ ollama: true });
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(useNimbusStore.getState().pullStalled).toBe(false);
  });

  it.each([
    ["completed", "llm.pullCompleted", {}],
    ["failed", "llm.pullFailed", { error: "registry unreachable" }],
  ])(
    "never marks a pull stalled once it %s, even one this dialog did not start",
    async (_l, method, extra) => {
      vi.useFakeTimers();
      await openWith({ ollama: true });
      emit("llm.pullProgress", progress({ pullId: "pull_elsewhere" }));
      emit(method, { pullId: "pull_elsewhere", provider: "ollama", modelName: "x", ...extra });
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(useNimbusStore.getState().pullStalled).toBe(false);
    },
  );

  it("stops the stall watchdog when the dialog is closed mid-pull", async () => {
    vi.useFakeTimers();
    llmPullModelMock.mockResolvedValueOnce({ pullId: "pull_1" });
    llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true } });
    const { rerender } = render(<PullDialog open onClose={() => {}} />);
    await waitFor(() => expect(llmGetStatusMock).toHaveBeenCalledTimes(1));
    await startPull();
    expect(useNimbusStore.getState().activePullId).toBe("pull_1");

    rerender(<PullDialog open={false} onClose={() => {}} />);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(useNimbusStore.getState().pullStalled).toBe(false);
  });

  it("re-arms the stall timer for a second pull started after the first completed", async () => {
    vi.useFakeTimers();
    llmPullModelMock
      .mockResolvedValueOnce({ pullId: "pull_1" })
      .mockResolvedValueOnce({ pullId: "pull_2" });
    await openWith({ ollama: true });
    await startPull();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    emit("llm.pullCompleted", { pullId: "pull_1", provider: "ollama", modelName: "gemma:2b" });

    await startPull("gemma:7b");
    expect(useNimbusStore.getState().activePullId).toBe("pull_2");
    act(() => {
      vi.advanceTimersByTime(14_000);
    });
    expect(screen.queryByText("Connecting…")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(useNimbusStore.getState().pullStalled).toBe(true);
  });
});

describe("PullDialog — subscription lifecycle", () => {
  it("releases a subscription that only resolves after the dialog unmounted", async () => {
    let resolveSub: (fn: () => void) => void = () => {};
    subscribeMock.mockImplementation(
      () =>
        new Promise<() => void>((r) => {
          resolveSub = r;
        }),
    );
    llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true } });
    const { unmount } = render(<PullDialog open onClose={() => {}} />);
    await act(async () => {});
    unmount();

    const unlisten = vi.fn();
    await act(async () => {
      resolveSub(unlisten);
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("holds a live subscription until unmount, then releases it once", async () => {
    const unlisten = vi.fn();
    subscribeMock.mockImplementation(async () => unlisten);
    llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true } });
    const { unmount } = render(<PullDialog open onClose={() => {}} />);
    await act(async () => {});
    expect(unlisten).not.toHaveBeenCalled();
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("still renders when the notification subscription is rejected", async () => {
    subscribeMock.mockRejectedValue(new Error("bridge down"));
    await openWith({ ollama: true });
    expect(screen.getByRole("dialog", { name: "Pull model" })).toBeInTheDocument();
    expect(screen.getByLabelText("Ollama")).toBeChecked();
  });

  it("calls onClose from the Close button", async () => {
    const onClose = vi.fn();
    llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true } });
    render(<PullDialog open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });
});
