import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ipc/client");

const openMock = vi.fn<() => Promise<string | null>>();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...(args as [])),
}));

import {
  callMock,
  extensionDisableMock,
  extensionEnableMock,
  extensionInstallMock,
  extensionRemoveMock,
} from "../../src/ipc/__mocks__/client";
import { Marketplace } from "../../src/pages/Marketplace";
import { useNimbusStore } from "../../src/store";

const EXT_1 = {
  id: "nimbus-git",
  version: "1.2.3",
  enabled: 1,
  installPath: "/extensions/nimbus-git",
  manifestHash: "abc",
};

const EXT_2 = {
  id: "nimbus-slack",
  version: "0.9.0",
  enabled: 0,
  installPath: "/extensions/nimbus-slack",
  manifestHash: "def",
};

function stubExtensionList(rows: unknown[]) {
  callMock.mockImplementation(async (method: string) => {
    if (method === "extension.list") return { extensions: rows };
    throw new Error(`unexpected method: ${method}`);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Marketplace />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  openMock.mockReset();
  extensionEnableMock.mockReset();
  extensionDisableMock.mockReset();
  extensionInstallMock.mockReset();
  extensionRemoveMock.mockReset();
  useNimbusStore.setState({ connectionState: "connected" });
});

describe("Marketplace page", () => {
  it("renders extension IDs and versions", async () => {
    stubExtensionList([EXT_1, EXT_2]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("nimbus-git")).toBeInTheDocument();
      expect(screen.getByText("nimbus-slack")).toBeInTheDocument();
    });
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    expect(screen.getByText("0.9.0")).toBeInTheDocument();
  });

  it("marks an orphaned dependency row and no other", async () => {
    stubExtensionList([{ ...EXT_1, orphaned: true }, EXT_2]);
    renderPage();
    expect(await screen.findByText("nimbus-git")).toBeInTheDocument();
    const markers = screen.getAllByTestId("orphaned-marker");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveTextContent("installed only as a dependency; nothing needs it now");
    expect(markers[0]?.closest("tr")).toHaveTextContent("nimbus-git");
  });

  it("shows no marker when the gateway sends no orphaned field", async () => {
    stubExtensionList([EXT_1, EXT_2]);
    renderPage();
    expect(await screen.findByText("nimbus-git")).toBeInTheDocument();
    expect(screen.queryByTestId("orphaned-marker")).toBeNull();
  });

  it("enabled checkbox reflects the extension state", async () => {
    stubExtensionList([EXT_1, EXT_2]);
    renderPage();
    expect(await screen.findByText("nimbus-git")).toBeInTheDocument();
    expect(screen.getByLabelText("nimbus-git enabled")).toBeChecked();
    expect(screen.getByLabelText("nimbus-slack enabled")).not.toBeChecked();
  });

  it("toggling an enabled extension calls extensionDisable", async () => {
    extensionDisableMock.mockResolvedValue({ ok: true });
    let listCallCount = 0;
    callMock.mockImplementation(async (method: string) => {
      if (method === "extension.checkForUpdates") return [];
      if (method === "extension.list") {
        listCallCount += 1;
        return listCallCount === 1
          ? { extensions: [EXT_1] }
          : { extensions: [{ ...EXT_1, enabled: 0 }] };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    renderPage();
    expect(await screen.findByLabelText("nimbus-git enabled")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("nimbus-git enabled"));
    expect(extensionDisableMock).toHaveBeenCalledWith("nimbus-git");
  });

  it("toggling a disabled extension calls extensionEnable", async () => {
    extensionEnableMock.mockResolvedValue({ ok: true });
    let listCallCount = 0;
    callMock.mockImplementation(async (method: string) => {
      if (method === "extension.checkForUpdates") return [];
      if (method === "extension.list") {
        listCallCount += 1;
        return listCallCount === 1
          ? { extensions: [EXT_2] }
          : { extensions: [{ ...EXT_2, enabled: 1 }] };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    renderPage();
    expect(await screen.findByLabelText("nimbus-slack enabled")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("nimbus-slack enabled"));
    expect(extensionEnableMock).toHaveBeenCalledWith("nimbus-slack");
  });

  it("calls extensionRemove after confirm", async () => {
    extensionRemoveMock.mockResolvedValue({ ok: true });
    let listCallCount = 0;
    callMock.mockImplementation(async (method: string) => {
      if (method === "extension.checkForUpdates") return [];
      if (method === "extension.list") {
        listCallCount += 1;
        return listCallCount === 1 ? { extensions: [EXT_1] } : { extensions: [] };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    renderPage();
    expect(await screen.findByText("nimbus-git")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /remove extension nimbus-git/i }));
    expect(extensionRemoveMock).toHaveBeenCalledWith("nimbus-git");
  });

  it("names the orphaned dependencies the gateway reports after a remove", async () => {
    extensionRemoveMock.mockResolvedValue({ ok: true, orphanedDependencies: ["dep.a", "dep.b"] });
    stubExtensionList([EXT_1]);
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: /remove extension nimbus-git/i }),
    );
    expect(await screen.findByTestId("orphan-notice")).toHaveTextContent(
      "Also installed only for nimbus-git: dep.a, dep.b. Remove them from the CLI with nimbus extension remove <id>.",
    );
  });

  async function showNotice(rows: unknown[]) {
    extensionRemoveMock.mockResolvedValue({ ok: true, orphanedDependencies: ["dep.a"] });
    stubExtensionList(rows);
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: /remove extension nimbus-git/i }),
    );
    expect(await screen.findByTestId("orphan-notice")).toBeInTheDocument();
  }

  it("the orphan notice can be dismissed", async () => {
    await showNotice([EXT_1]);
    await userEvent.click(screen.getByRole("button", { name: /dismiss notice/i }));
    expect(screen.queryByTestId("orphan-notice")).toBeNull();
  });

  it("the next enable or disable clears the orphan notice", async () => {
    extensionEnableMock.mockResolvedValue({ ok: true });
    await showNotice([EXT_1, EXT_2]);
    await userEvent.click(screen.getByLabelText("nimbus-slack enabled"));
    expect(extensionEnableMock).toHaveBeenCalledWith("nimbus-slack");
    expect(screen.queryByTestId("orphan-notice")).toBeNull();
  });

  it("the next install clears the orphan notice", async () => {
    openMock.mockResolvedValue(null);
    await showNotice([EXT_1]);
    await userEvent.click(screen.getByRole("button", { name: /install from directory/i }));
    await waitFor(() => expect(openMock).toHaveBeenCalled());
    expect(screen.queryByTestId("orphan-notice")).toBeNull();
  });

  it("the next remove clears the orphan notice before it answers", async () => {
    await showNotice([EXT_1, EXT_2]);
    let answer: (v: unknown) => void = () => {};
    extensionRemoveMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await userEvent.click(screen.getByRole("button", { name: /remove extension nimbus-slack/i }));
    await waitFor(() => expect(extensionRemoveMock).toHaveBeenCalledWith("nimbus-slack"));
    expect(screen.queryByTestId("orphan-notice")).toBeNull();
    await act(async () => {
      answer({ ok: true });
    });
    await waitFor(() => expect(screen.getByLabelText("nimbus-slack enabled")).toBeEnabled());
  });

  it("shows no notice when an older gateway sends no orphanedDependencies", async () => {
    extensionRemoveMock.mockResolvedValue({ ok: true });
    stubExtensionList([EXT_1]);
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: /remove extension nimbus-git/i }),
    );
    await waitFor(() => expect(extensionRemoveMock).toHaveBeenCalled());
    expect(screen.queryByTestId("orphan-notice")).toBeNull();
  });

  it("opens directory dialog and calls extensionInstall with the selected path", async () => {
    stubExtensionList([]);
    openMock.mockResolvedValue("/my/extension/dir");
    extensionInstallMock.mockResolvedValue({
      id: "my-ext",
      version: "1.0.0",
      installPath: "/extensions/my-ext",
      manifestHash: "xyz",
      entryHash: "uvw",
    });
    renderPage();
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /install from directory/i }));
    expect(openMock).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(extensionInstallMock).toHaveBeenCalledWith("/my/extension/dir");
  });

  it("does not call extensionInstall when dialog returns null", async () => {
    stubExtensionList([]);
    openMock.mockResolvedValue(null);
    renderPage();
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /install from directory/i }));
    expect(extensionInstallMock).not.toHaveBeenCalled();
  });

  it("shows error state when extension.list fails", async () => {
    callMock.mockRejectedValue(new Error("socket closed"));
    renderPage();
    expect(await screen.findByText(/socket closed/)).toBeInTheDocument();
  });

  it("sandbox badge displays 'Process isolation' for every extension", async () => {
    stubExtensionList([EXT_1, EXT_2]);
    renderPage();
    expect(await screen.findByText("nimbus-git")).toBeInTheDocument();
    const badges = screen.getAllByTestId("sandbox-badge");
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      expect(badge).toHaveTextContent("Process isolation");
    }
  });

  it("'Install from directory' button is disabled when offline", () => {
    useNimbusStore.setState({ connectionState: "disconnected" });
    callMock.mockResolvedValue({ extensions: [] });
    renderPage();
    expect(screen.getByRole("button", { name: /install from directory/i })).toBeDisabled();
  });
});
