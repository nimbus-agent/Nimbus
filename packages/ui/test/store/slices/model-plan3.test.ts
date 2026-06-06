import { beforeEach, describe, expect, it } from "vitest";
import { useNimbusStore } from "../../../src/store";

beforeEach(() => {
  localStorage.clear();
  useNimbusStore.setState({
    installedModels: [],
    activePullId: null,
    routerStatus: null,
    pullProgress: {},
    pullStalled: false,
    loadedKeys: {},
  });
});

describe("ModelSlice — Plan 3 additions", () => {
  it("setRouterStatus stores the decisions map", () => {
    const status = {
      decisions: {
        classification: { providerId: "ollama", modelName: "gemma:2b", reason: "default" },
      },
    } as const;
    useNimbusStore.getState().setRouterStatus(status);
    expect(useNimbusStore.getState().routerStatus?.decisions.classification?.modelName).toBe(
      "gemma:2b",
    );
  });

  it("upsertPullProgress + clearPullProgress round-trip one pullId", () => {
    useNimbusStore.getState().upsertPullProgress({
      pullId: "pull_abc",
      provider: "ollama",
      modelName: "gemma:2b",
      status: "downloading",
      completedBytes: 100,
      totalBytes: 1000,
    });
    expect(useNimbusStore.getState().pullProgress.pull_abc?.completedBytes).toBe(100);
    useNimbusStore.getState().clearPullProgress("pull_abc");
    expect(useNimbusStore.getState().pullProgress.pull_abc).toBeUndefined();
  });

  it("setPullStalled is idempotent", () => {
    useNimbusStore.getState().setPullStalled(true);
    useNimbusStore.getState().setPullStalled(true);
    expect(useNimbusStore.getState().pullStalled).toBe(true);
    useNimbusStore.getState().setPullStalled(false);
    expect(useNimbusStore.getState().pullStalled).toBe(false);
  });

  it("patchLoaded writes per-composite-key flags", () => {
    useNimbusStore.getState().patchLoaded("ollama", "gemma:2b", true);
    useNimbusStore.getState().patchLoaded("llamacpp", "llama3:8b", false);
    expect(useNimbusStore.getState().loadedKeys).toEqual({
      "ollama:gemma:2b": true,
      "llamacpp:llama3:8b": false,
    });
  });
});

describe("ModelSlice — persist whitelist unchanged", () => {
  it("routerStatus, pullProgress, pullStalled, loadedKeys are NOT persisted", () => {
    useNimbusStore.setState({
      routerStatus: {
        decisions: { classification: { providerId: "ollama", modelName: "x", reason: "r" } },
      },
      pullProgress: {
        pull_x: {
          pullId: "pull_x",
          provider: "ollama",
          modelName: "x",
          status: "s",
        },
      },
      pullStalled: true,
      loadedKeys: { "ollama:x": true },
    });
    const raw = localStorage.getItem("nimbus-ui-store");
    if (raw === null) return;
    const parsed = JSON.parse(raw);
    expect(parsed.state?.routerStatus).toBeUndefined();
    expect(parsed.state?.pullProgress).toBeUndefined();
    expect(parsed.state?.pullStalled).toBeUndefined();
    expect(parsed.state?.loadedKeys).toBeUndefined();
  });
});
