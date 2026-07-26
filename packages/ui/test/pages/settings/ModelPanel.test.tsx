import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/ipc/client");

import {
  llmGetRouterStatusMock,
  llmGetStatusMock,
  llmListModelsMock,
  llmLoadModelMock,
  llmSetDefaultMock,
  llmUnloadModelMock,
  subscribeMock,
} from "../../../src/ipc/__mocks__/client";
import { ModelPanel } from "../../../src/pages/settings/ModelPanel";
import { useNimbusStore } from "../../../src/store";

function renderPanel() {
  return render(
    <MemoryRouter>
      <ModelPanel />
    </MemoryRouter>,
  );
}

type NotificationHandler = (n: { method: string; params: unknown }) => void;

function captureSubscribe(): { handler: NotificationHandler | null } {
  const ref: { handler: NotificationHandler | null } = { handler: null };
  subscribeMock.mockImplementation(async (h: NotificationHandler) => {
    ref.handler = h;
    return () => {};
  });
  return ref;
}

beforeEach(() => {
  localStorage.clear();
  llmListModelsMock.mockReset();
  llmGetRouterStatusMock.mockReset();
  llmGetStatusMock.mockReset();
  llmLoadModelMock.mockReset();
  llmUnloadModelMock.mockReset();
  llmSetDefaultMock.mockReset();
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

describe("ModelPanel", () => {
  it("fetches listModels and getRouterStatus on mount and renders both", async () => {
    llmListModelsMock.mockResolvedValueOnce({
      models: [
        { provider: "ollama", modelName: "gemma:2b" },
        { provider: "llamacpp", modelName: "llama3:8b-q4" },
      ],
    });
    llmGetRouterStatusMock.mockResolvedValueOnce({
      decisions: {
        classification: { providerId: "ollama", modelName: "gemma:2b", reason: "default" },
      },
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("gemma:2b")).toBeInTheDocument();
      expect(screen.getByText("llama3:8b-q4")).toBeInTheDocument();
      expect(screen.getByTestId("router-status")).toBeInTheDocument();
    });
  });

  it("Load button calls llmLoadModel with the row's provider + modelName", async () => {
    llmListModelsMock.mockResolvedValueOnce({
      models: [{ provider: "ollama", modelName: "gemma:2b" }],
    });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    llmLoadModelMock.mockResolvedValueOnce({ isLoaded: true });
    renderPanel();
    await screen.findByRole("button", { name: /load gemma:2b/i });
    await userEvent.click(screen.getByRole("button", { name: /load gemma:2b/i }));
    await waitFor(() => expect(llmLoadModelMock).toHaveBeenCalledWith("ollama", "gemma:2b"));
  });

  it("Unload button calls llmUnloadModel when the row is loaded", async () => {
    useNimbusStore.setState({ loadedKeys: { "ollama:gemma:2b": true } });
    llmListModelsMock.mockResolvedValueOnce({
      models: [{ provider: "ollama", modelName: "gemma:2b" }],
    });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    llmUnloadModelMock.mockResolvedValueOnce({ isLoaded: false });
    renderPanel();
    await screen.findByRole("button", { name: /unload gemma:2b/i });
    await userEvent.click(screen.getByRole("button", { name: /unload gemma:2b/i }));
    await waitFor(() => expect(llmUnloadModelMock).toHaveBeenCalledWith("ollama", "gemma:2b"));
  });

  it("Set-default picker calls llmSetDefault with taskType, provider, modelName", async () => {
    llmListModelsMock.mockResolvedValueOnce({
      models: [{ provider: "ollama", modelName: "gemma:2b" }],
    });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    llmSetDefaultMock.mockResolvedValueOnce({
      taskType: "reasoning",
      provider: "ollama",
      modelName: "gemma:2b",
    });
    llmGetRouterStatusMock.mockResolvedValueOnce({
      decisions: {
        reasoning: { providerId: "ollama", modelName: "gemma:2b", reason: "default" },
      },
    });
    renderPanel();
    await screen.findByLabelText("gemma:2b default-for");
    await userEvent.selectOptions(screen.getByLabelText("gemma:2b default-for"), "reasoning");
    await waitFor(() =>
      expect(llmSetDefaultMock).toHaveBeenCalledWith("reasoning", "ollama", "gemma:2b"),
    );
  });

  it("opens PullDialog when 'Pull new model…' is clicked", async () => {
    llmListModelsMock.mockResolvedValueOnce({ models: [] });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true, llamacpp: true } });
    renderPanel();
    await screen.findByRole("button", { name: /pull new model/i });
    await userEvent.click(screen.getByRole("button", { name: /pull new model/i }));
    expect(await screen.findByRole("dialog", { name: /pull model/i })).toBeInTheDocument();
  });

  it("llm.modelLoaded notification patches the row's loaded indicator", async () => {
    llmListModelsMock.mockResolvedValueOnce({
      models: [{ provider: "ollama", modelName: "gemma:2b" }],
    });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    const sub = captureSubscribe();
    renderPanel();
    await screen.findByRole("button", { name: /load gemma:2b/i });
    sub.handler?.({
      method: "llm.modelLoaded",
      params: { provider: "ollama", modelName: "gemma:2b" },
    });
    expect(await screen.findByRole("button", { name: /unload gemma:2b/i })).toBeInTheDocument();
  });

  it("surfaces pull progress from a persisted activePullId (re-attach on reload)", async () => {
    useNimbusStore.setState({
      activePullId: "pull_abc",
      pullProgress: {
        pull_abc: {
          pullId: "pull_abc",
          provider: "ollama",
          modelName: "gemma:2b",
          status: "downloading",
          completedBytes: 250,
          totalBytes: 1000,
        },
      },
    });
    llmListModelsMock.mockResolvedValueOnce({ models: [] });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("active-pull-banner")).toHaveTextContent(/gemma:2b/),
    );
    expect(screen.getByTestId("active-pull-banner")).toHaveTextContent(/25%/);
  });

  it("llm.modelUnloaded notification patches the row's loaded state to false", async () => {
    useNimbusStore.setState({ loadedKeys: { "ollama:gemma:2b": true } });
    llmListModelsMock.mockResolvedValueOnce({
      models: [{ provider: "ollama", modelName: "gemma:2b" }],
    });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    const sub = captureSubscribe();
    renderPanel();
    await screen.findByRole("button", { name: /unload gemma:2b/i });
    sub.handler?.({
      method: "llm.modelUnloaded",
      params: { provider: "ollama", modelName: "gemma:2b" },
    });
    expect(await screen.findByRole("button", { name: /load gemma:2b/i })).toBeInTheDocument();
  });

  it("llm.pullProgress notification updates the active pull banner", async () => {
    useNimbusStore.setState({ activePullId: "pull_x" });
    llmListModelsMock.mockResolvedValueOnce({ models: [] });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    const sub = captureSubscribe();
    renderPanel();
    await screen.findByRole("button", { name: /pull new model/i });
    sub.handler?.({
      method: "llm.pullProgress",
      params: {
        pullId: "pull_x",
        provider: "ollama",
        modelName: "gemma:2b",
        status: "downloading",
        completedBytes: 500,
        totalBytes: 1000,
      },
    });
    await waitFor(() => expect(screen.getByTestId("active-pull-banner")).toHaveTextContent(/50%/));
  });

  it("llm.pullCompleted clears the active pull and re-fetches models", async () => {
    useNimbusStore.setState({ activePullId: "pull_done" });
    llmListModelsMock.mockResolvedValueOnce({ models: [] });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    llmListModelsMock.mockResolvedValueOnce({
      models: [{ provider: "ollama", modelName: "gemma:2b" }],
    });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    const sub = captureSubscribe();
    renderPanel();
    await screen.findByRole("button", { name: /pull new model/i });
    sub.handler?.({ method: "llm.pullCompleted", params: { pullId: "pull_done" } });
    await waitFor(() => expect(llmListModelsMock).toHaveBeenCalledTimes(2));
    expect(useNimbusStore.getState().activePullId).toBeNull();
  });

  it("llm.pullFailed clears the active pull without re-fetching models", async () => {
    useNimbusStore.setState({ activePullId: "pull_fail" });
    llmListModelsMock.mockResolvedValueOnce({ models: [] });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    const sub = captureSubscribe();
    renderPanel();
    await screen.findByRole("button", { name: /pull new model/i });
    sub.handler?.({ method: "llm.pullFailed", params: { pullId: "pull_fail" } });
    await waitFor(() => expect(useNimbusStore.getState().activePullId).toBeNull());
    expect(llmListModelsMock).toHaveBeenCalledTimes(1);
  });

  it("handles subscribe() rejection gracefully without crashing", async () => {
    llmListModelsMock.mockResolvedValueOnce({ models: [] });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    subscribeMock.mockRejectedValueOnce(new Error("subscribe failed"));
    renderPanel();
    await screen.findByRole("button", { name: /pull new model/i });
    expect(screen.getByRole("button", { name: /pull new model/i })).toBeInTheDocument();
  });

  it("PullDialog closes when Close button is clicked", async () => {
    llmListModelsMock.mockResolvedValueOnce({ models: [] });
    llmGetRouterStatusMock.mockResolvedValueOnce({ decisions: {} });
    llmGetStatusMock.mockResolvedValueOnce({ available: { ollama: true, llamacpp: false } });
    renderPanel();
    await screen.findByRole("button", { name: /pull new model/i });
    await userEvent.click(screen.getByRole("button", { name: /pull new model/i }));
    await screen.findByRole("dialog", { name: /pull model/i });
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /pull model/i })).not.toBeInTheDocument(),
    );
  });

  it("disables write controls when connectionState=disconnected", async () => {
    useNimbusStore.setState({ connectionState: "disconnected" });
    llmListModelsMock.mockRejectedValueOnce(new Error("offline"));
    llmGetRouterStatusMock.mockRejectedValueOnce(new Error("offline"));
    useNimbusStore.setState({
      installedModels: [{ id: "ollama:gemma:2b", provider: "ollama" }],
    });
    renderPanel();
    await screen.findByRole("button", { name: /pull new model/i });
    expect(screen.getByRole("button", { name: /pull new model/i })).toBeDisabled();
  });
});
