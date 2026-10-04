import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/ipc/client");

import { DeleteServiceDialog } from "../../../../src/components/settings/data/DeleteServiceDialog";
import { dataDeleteMock, dataGetDeletePreflightMock } from "../../../../src/ipc/__mocks__/client";
import { useNimbusStore } from "../../../../src/store";

function row(service: string) {
  return {
    service,
    intervalMs: 60000,
    depth: "summary",
    enabled: true,
    health: "healthy",
  } as const;
}

function preflightFor(service: string) {
  return { service, itemCount: 12, embeddingCount: 3, vaultKeyCount: 1 };
}

function deleteResult(deleted: boolean, itemsToDelete = 12) {
  return {
    deleted,
    preflight: {
      service: "github",
      itemsToDelete,
      vecRowsToDelete: 0,
      syncTokensToDelete: 0,
      vaultEntriesToDelete: 1,
      vaultKeys: [],
      peopleUnlinked: 0,
    },
  };
}

async function toPreview(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
  });
}

async function toConfirmAndDelete(service = "github"): Promise<void> {
  await toPreview();
  fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
  fireEvent.change(screen.getByPlaceholderText(service), { target: { value: service } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  });
}

beforeEach(() => {
  dataGetDeletePreflightMock.mockReset();
  dataDeleteMock.mockReset();
  useNimbusStore.setState({
    deleteFlow: { status: "idle", service: null, errorKind: null, errorMessage: null },
    connectorsList: [row("github"), row("filesystem")],
  });
});

afterEach(() => {
  cleanup();
});

describe("DeleteServiceDialog — picking", () => {
  it("says no services are configured and keeps Next disabled", () => {
    useNimbusStore.setState({ connectorsList: [] });
    render(<DeleteServiceDialog onClose={() => {}} />);
    const select = screen.getByRole("combobox", { name: "Service" });
    expect(select).toBeDisabled();
    expect(screen.getByRole("option", { name: "No services configured" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("preselects the first service once a connector list that arrived late is in", () => {
    useNimbusStore.setState({ connectorsList: [] });
    render(<DeleteServiceDialog onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    act(() => {
      useNimbusStore.setState({ connectorsList: [row("jira"), row("github")] });
    });
    expect(screen.getByRole("combobox", { name: "Service" })).toHaveValue("jira");
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();
  });

  it("previews whichever service was picked", async () => {
    dataGetDeletePreflightMock.mockResolvedValue(preflightFor("filesystem"));
    render(<DeleteServiceDialog onClose={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Service" })).toHaveValue("github");
    expect(screen.getByRole("combobox", { name: "Service" })).not.toBeDisabled();
    expect(screen.queryByTestId("preflight-loading")).toBeNull();
    expect(screen.queryByRole("option", { name: "No services configured" })).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Service" }), {
      target: { value: "filesystem" },
    });
    await toPreview();
    expect(dataGetDeletePreflightMock).toHaveBeenCalledWith({ service: "filesystem" });
    expect(
      screen.getByRole("heading", { name: "Confirm deletion of filesystem" }),
    ).toBeInTheDocument();
    // The picker belongs to the first step only.
    expect(screen.queryByRole("heading", { name: "Delete service data" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Service" })).toBeNull();
  });

  it("shows a calculating hint while the preflight is loading", async () => {
    let finish: (v: unknown) => void = () => {};
    dataGetDeletePreflightMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    render(<DeleteServiceDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByTestId("preflight-loading")).toHaveTextContent("Calculating…");

    await act(async () => {
      finish(preflightFor("github"));
    });
    expect(screen.queryByTestId("preflight-loading")).toBeNull();
    expect(screen.getByRole("heading", { name: "Confirm deletion of github" })).toBeInTheDocument();
  });

  it("closes from the picker's Cancel", () => {
    const onClose = vi.fn();
    render(<DeleteServiceDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("DeleteServiceDialog — navigation", () => {
  it("walks back from the confirmation to the preview and from the preview to the picker", async () => {
    dataGetDeletePreflightMock.mockResolvedValue(preflightFor("github"));
    render(<DeleteServiceDialog onClose={() => {}} />);
    await toPreview();
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
    fireEvent.change(screen.getByPlaceholderText("github"), { target: { value: "git" } });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Confirm deletion of github" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
    expect(screen.getByPlaceholderText("github")).toHaveValue("git");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Delete service data" })).toBeInTheDocument();
    // The earlier preflight finished: back on the picker there is nothing left "calculating".
    expect(screen.queryByTestId("preflight-loading")).toBeNull();
    expect(dataDeleteMock).not.toHaveBeenCalled();
  });
});

describe("DeleteServiceDialog — failures", () => {
  it("shows the preflight error and closes from the error step", async () => {
    dataGetDeletePreflightMock.mockRejectedValue(new Error("index busy"));
    const onClose = vi.fn();
    render(<DeleteServiceDialog onClose={onClose} />);
    await toPreview();
    expect(screen.getByRole("heading", { name: "Delete failed" })).toBeInTheDocument();
    expect(screen.getByText("index busy")).toBeInTheDocument();
    expect(screen.queryByTestId("preflight-loading")).toBeNull();
    // A preflight failure happens before anything was attempted: the flow state is untouched.
    expect(useNimbusStore.getState().deleteFlow.status).toBe("idle");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("records a delete failure against the service", async () => {
    dataGetDeletePreflightMock.mockResolvedValue(preflightFor("github"));
    dataDeleteMock.mockRejectedValue(new Error("vault locked"));
    render(<DeleteServiceDialog onClose={() => {}} />);
    await toConfirmAndDelete();

    expect(screen.getByRole("heading", { name: "Delete failed" })).toBeInTheDocument();
    expect(screen.getByText("vault locked")).toBeInTheDocument();
    expect(useNimbusStore.getState().deleteFlow).toEqual({
      status: "error",
      errorKind: "rpc_failed",
      errorMessage: "vault locked",
      service: "github",
    });
  });

  it("falls back to a generic message when the failure carries no message", async () => {
    dataGetDeletePreflightMock.mockResolvedValue(preflightFor("github"));
    dataDeleteMock.mockRejectedValue("E_PLAIN");
    render(<DeleteServiceDialog onClose={() => {}} />);
    await toConfirmAndDelete();
    expect(screen.getByText("Delete failed — data unchanged.")).toBeInTheDocument();
    expect(screen.queryByText("E_PLAIN")).toBeNull();
  });
});

describe("DeleteServiceDialog — rehydrated store", () => {
  const STORE_KEY = "nimbus-ui-store";

  afterEach(() => {
    localStorage.removeItem(STORE_KEY);
  });

  // `connectorsList` is persisted, and zustand's default merge is a shallow spread, so a stored
  // `null` (an old or hand-edited entry) replaces the slice's `[]` default on rehydration.
  it("treats a rehydrated null connector list as no configured services", async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ state: { connectorsList: null }, version: 1 }),
    );
    await act(async () => {
      await useNimbusStore.persist.rehydrate();
    });
    // Premise: rehydration really delivered the null, so the dialog's fallback is what is tested.
    expect(useNimbusStore.getState().connectorsList).toBeNull();

    render(<DeleteServiceDialog onClose={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Service" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "No services configured" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});

describe("DeleteServiceDialog — deleting", () => {
  it("shows progress and records the running flow until the delete settles", async () => {
    let finish: (v: unknown) => void = () => {};
    dataGetDeletePreflightMock.mockResolvedValue(preflightFor("github"));
    dataDeleteMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    render(<DeleteServiceDialog onClose={() => {}} />);
    await toConfirmAndDelete();

    expect(screen.getByRole("heading", { name: "Deleting…" })).toBeInTheDocument();
    expect(screen.getByText("Removing data for github.")).toBeInTheDocument();
    expect(useNimbusStore.getState().deleteFlow).toMatchObject({
      status: "running",
      service: "github",
    });

    await act(async () => {
      finish(deleteResult(true, 7));
    });
    expect(screen.getByText(/Deleted 7 items from/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Deleting…" })).toBeNull();
    expect(useNimbusStore.getState().deleteFlow.status).toBe("idle");
  });

  it("says nothing was deleted when the gateway reports deleted: false", async () => {
    dataGetDeletePreflightMock.mockResolvedValue(preflightFor("github"));
    dataDeleteMock.mockResolvedValue(deleteResult(false));
    const onClose = vi.fn();
    render(<DeleteServiceDialog onClose={onClose} />);
    await toConfirmAndDelete();
    expect(
      screen.getByText("Nothing was deleted (server returned `deleted: false`)."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Deleted \d+ items/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
