import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteServiceDialog } from "../../../../src/components/settings/data/DeleteServiceDialog";
import { dataDeleteMock, dataGetDeletePreflightMock } from "../../../../src/ipc/__mocks__/client";
import { useNimbusStore } from "../../../../src/store";

vi.mock("../../../../src/ipc/client");

function resetStore() {
  useNimbusStore.setState({
    deleteFlow: { status: "idle" },
    setDeleteFlow: (patch: Record<string, unknown>) =>
      useNimbusStore.setState(
        (s) =>
          ({
            deleteFlow: { ...s.deleteFlow, ...patch },
          }),
      ),
    connectorsList: [
      {
        service: "github",
        intervalMs: 60000,
        depth: "metadata_only",
        enabled: true,
        health: "healthy",
      },
      {
        service: "filesystem",
        intervalMs: 60000,
        depth: "metadata_only",
        enabled: true,
        health: "healthy",
      },
    ],
  } as never);
}

describe("DeleteServiceDialog — dropdown population", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("shows all services from connectorsList in dropdown", async () => {
    render(<DeleteServiceDialog onClose={() => {}} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("github");
    expect(values).toContain("filesystem");
  });
});

async function renderAndAdvanceToProceed(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(<DeleteServiceDialog onClose={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(await screen.findByRole("button", { name: "Proceed" }));
}

describe("DeleteServiceDialog — preflight + typed confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("renders preflight counts after loading", async () => {
    dataGetDeletePreflightMock.mockResolvedValue({
      service: "github",
      itemCount: 1247,
      embeddingCount: 89,
      vaultKeyCount: 3,
    });
    const user = userEvent.setup();
    render(<DeleteServiceDialog onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await vi.waitFor(() => {
      expect(screen.getByText("1247")).toBeInTheDocument();
    });
    expect(screen.getByText("89")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("typed confirmation is case-sensitive and rejects trailing space", async () => {
    dataGetDeletePreflightMock.mockResolvedValue({
      service: "github",
      itemCount: 1,
      embeddingCount: 0,
      vaultKeyCount: 0,
    });
    const user = userEvent.setup();
    await renderAndAdvanceToProceed(user);
    const input = screen.getByPlaceholderText("github") as HTMLInputElement;
    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    await user.type(input, "GitHub");
    expect(deleteBtn).toBeDisabled();
    await user.clear(input);
    await user.type(input, "github ");
    expect(deleteBtn).toBeDisabled();
    await user.clear(input);
    await user.type(input, "github");
    expect(deleteBtn).not.toBeDisabled();
  });

  it("calls dataDelete with explicit dryRun: false", async () => {
    dataGetDeletePreflightMock.mockResolvedValue({
      service: "github",
      itemCount: 5,
      embeddingCount: 0,
      vaultKeyCount: 0,
    });
    dataDeleteMock.mockResolvedValue({
      preflight: {
        service: "github",
        itemsToDelete: 5,
        vecRowsToDelete: 0,
        syncTokensToDelete: 0,
        vaultEntriesToDelete: 0,
        vaultKeys: [],
        peopleUnlinked: 0,
      },
      deleted: true,
    });
    const user = userEvent.setup();
    await renderAndAdvanceToProceed(user);
    await user.type(screen.getByPlaceholderText("github"), "github");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(dataDeleteMock).toHaveBeenCalledWith({ service: "github", dryRun: false });
  });

  it("renders success copy with itemsToDelete count from preflight", async () => {
    dataGetDeletePreflightMock.mockResolvedValue({
      service: "github",
      itemCount: 5,
      embeddingCount: 0,
      vaultKeyCount: 0,
    });
    dataDeleteMock.mockResolvedValue({
      preflight: {
        service: "github",
        itemsToDelete: 42,
        vecRowsToDelete: 0,
        syncTokensToDelete: 0,
        vaultEntriesToDelete: 0,
        vaultKeys: [],
        peopleUnlinked: 0,
      },
      deleted: true,
    });
    const user = userEvent.setup();
    await renderAndAdvanceToProceed(user);
    await user.type(screen.getByPlaceholderText("github"), "github");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => {
      expect(screen.getByText(/Deleted 42 items/)).toBeInTheDocument();
    });
  });
});
