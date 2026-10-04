import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listeners, openMock } = vi.hoisted(() => ({
  listeners: new Map<string, Array<(payload: unknown) => void>>(),
  openMock: vi.fn<(opts: unknown) => Promise<string | string[] | null>>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    const cb = (payload: unknown) => handler({ payload });
    listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    return () => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((f) => f !== cb),
      );
    };
  }),
}));
vi.mock("../../../../src/ipc/client");
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));

import { ImportWizard } from "../../../../src/components/settings/data/ImportWizard";
import { dataImportMock } from "../../../../src/ipc/__mocks__/client";
import { JsonRpcError } from "../../../../src/ipc/types";
import { useNimbusStore } from "../../../../src/store";

const BUNDLE = "/mock-input/nimbus.tar.gz";

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderWizard(onClose: () => void = () => {}) {
  return render(
    <MemoryRouter>
      <ImportWizard onClose={onClose} />
    </MemoryRouter>,
  );
}

function fireNotification(method: string, params: unknown): void {
  for (const h of listeners.get("gateway://notification") ?? []) {
    act(() => h({ method, params }));
  }
}

async function toAuth(): Promise<void> {
  openMock.mockResolvedValue(BUNDLE);
  fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
  await screen.findByRole("heading", { name: "Unlock the backup" });
}

function toConfirmWithPassphrase(pw = "demo-passphrase"): void {
  fireEvent.change(screen.getByPlaceholderText("Passphrase"), { target: { value: pw } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(
    screen.getByRole("heading", { name: "This replaces your current data" }),
  ).toBeInTheDocument();
}

async function confirmImport(): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText("replace my data"), {
    target: { value: "replace my data" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Replace my data" }));
  });
}

async function importFailingWith(err: unknown): Promise<void> {
  dataImportMock.mockRejectedValue(err);
  renderWizard();
  await toAuth();
  toConfirmWithPassphrase();
  await confirmImport();
}

beforeEach(() => {
  listeners.clear();
  openMock.mockReset();
  dataImportMock.mockReset();
  useNimbusStore.setState({
    importFlow: { status: "idle", progress: null, errorKind: null, errorMessage: null },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ImportWizard — file step", () => {
  it("stays on the file step when the picker is dismissed", async () => {
    openMock.mockResolvedValue(null);
    renderWizard();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    });
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledWith({
      filters: [{ name: "Nimbus backup", extensions: ["tar.gz"] }],
    });
    expect(screen.getByRole("heading", { name: "Pick a backup file" })).toBeInTheDocument();
  });

  it("ignores a multi-file selection", async () => {
    openMock.mockResolvedValue(["/a.tar.gz", "/b.tar.gz"]);
    renderWizard();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    });
    expect(screen.getByRole("heading", { name: "Pick a backup file" })).toBeInTheDocument();
    expect(screen.queryByText("/a.tar.gz")).toBeNull();
  });

  it("closes from the file step", () => {
    const onClose = vi.fn();
    renderWizard(onClose);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ImportWizard — navigation and auth", () => {
  it("walks back from confirm to auth and from auth to file", async () => {
    renderWizard();
    await toAuth();
    expect(screen.getByText(BUNDLE)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pick a backup file" })).toBeNull();
    toConfirmWithPassphrase();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Unlock the backup" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Passphrase")).toHaveValue("demo-passphrase");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Pick a backup file" })).toBeInTheDocument();
  });

  it("switches between the seed grid and the passphrase field", async () => {
    renderWizard();
    await toAuth();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: /Recovery seed/ }));
    expect(screen.getByRole("radio", { name: /Recovery seed/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Passphrase" })).not.toBeChecked();
    expect(screen.getByTestId("bip39-grid")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Passphrase")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Passphrase" }));
    expect(screen.queryByTestId("bip39-grid")).toBeNull();
    expect(screen.getByRole("radio", { name: "Passphrase" })).toBeChecked();
    fireEvent.change(screen.getByPlaceholderText("Passphrase"), { target: { value: "x" } });
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();
  });

  it("lower-cases seed words and gates Next on all twelve looking like words", async () => {
    dataImportMock.mockResolvedValue({ credentialsRestored: 2, oauthEntriesFlagged: 0 });
    vi.stubGlobal("location", { ...globalThis.location, reload: vi.fn() });
    renderWizard();
    await toAuth();
    fireEvent.click(screen.getByRole("radio", { name: /Recovery seed/ }));

    const words = Array.from({ length: 12 }, (_, i) => screen.getByLabelText(`Word ${i + 1}`));
    fireEvent.change(words[0] as HTMLElement, { target: { value: "ABANDON" } });
    expect(words[0]).toHaveValue("abandon");
    expect((words[0] as HTMLElement).className).not.toContain("border-[var(--color-danger)]");

    fireEvent.change(words[1] as HTMLElement, { target: { value: "ab" } });
    expect((words[1] as HTMLElement).className).toContain("border-[var(--color-danger)]");
    for (let i = 2; i < 12; i++) {
      fireEvent.change(words[i] as HTMLElement, { target: { value: "zoo" } });
    }
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    fireEvent.change(words[1] as HTMLElement, { target: { value: "ability" } });
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    // Fake timers keep the post-import reload timer from firing after this test.
    vi.useFakeTimers();
    await confirmImport();

    expect(dataImportMock).toHaveBeenCalledWith({
      bundlePath: BUNDLE,
      recoverySeed: "abandon ability zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo",
    });
  });
});

describe("ImportWizard — recovery seed words", () => {
  const DANGER = "border-[var(--color-danger)]";

  async function toSeedGrid(): Promise<HTMLElement[]> {
    renderWizard();
    await toAuth();
    fireEvent.click(screen.getByRole("radio", { name: /Recovery seed/ }));
    return Array.from({ length: 12 }, (_, i) => screen.getByLabelText(`Word ${i + 1}`));
  }

  it.each([
    ["a trailing digit", "zoo1"],
    ["a leading digit", "1zoo"],
  ])("flags a word with %s and keeps Next disabled", async (_label, word) => {
    const words = await toSeedGrid();
    for (const w of words) fireEvent.change(w, { target: { value: "zoo" } });
    // Control: twelve plain words are accepted.
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();

    fireEvent.change(words[0] as HTMLElement, { target: { value: word } });
    expect((words[0] as HTMLElement).className).toContain(DANGER);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("does not flag untouched fields, and accepts a word with stray surrounding spaces", async () => {
    const words = await toSeedGrid();
    for (const w of words) expect(w.className).not.toContain(DANGER);

    fireEvent.change(words[0] as HTMLElement, { target: { value: "  zoo  " } });
    expect((words[0] as HTMLElement).className).not.toContain(DANGER);
  });
});

describe("ImportWizard — error classification", () => {
  it("treats -32003 as a terminal corrupt-archive failure without a deep link", async () => {
    await importFailingWith(new JsonRpcError({ code: -32003, message: "hmac mismatch" }));
    expect(
      await screen.findByText("Archive is corrupt or tampered. No changes made."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Go to Updates" })).toBeNull();
    expect(useNimbusStore.getState().importFlow).toMatchObject({
      status: "error",
      errorKind: "terminal",
    });
  });

  it("treats -32010 without version data as the older/unsupported case", async () => {
    await importFailingWith(new JsonRpcError({ code: -32010, message: "version mismatch" }));
    expect(await screen.findByText(/older, unsupported Nimbus/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to Updates" })).toBeNull();
    // Terminal, not retryable: there is no migration path to retry into.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(useNimbusStore.getState().importFlow).toMatchObject({
      status: "error",
      errorKind: "terminal",
    });
  });

  it("closes the wizard and opens Updates from the newer-archive deep link", async () => {
    dataImportMock.mockRejectedValue(
      new JsonRpcError({
        code: -32010,
        message: "version mismatch",
        data: { relation: "archive_newer" },
      }),
    );
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={["/settings/data"]}>
        <ImportWizard onClose={onClose} />
        <LocationProbe />
      </MemoryRouter>,
    );
    await toAuth();
    toConfirmWithPassphrase();
    await confirmImport();

    fireEvent.click(await screen.findByRole("button", { name: "Go to Updates" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/settings/updates"),
    );
  });

  it("records -32002 as a validation failure", async () => {
    await importFailingWith(new JsonRpcError({ code: -32002, message: "bad key" }));
    await screen.findByText("Could not decrypt with that passphrase. Check and retry.");
    expect(useNimbusStore.getState().importFlow).toMatchObject({
      status: "error",
      errorKind: "validation",
      errorMessage: null,
    });
  });

  it("reports a plain Error as a retryable rpc failure that keeps the data unchanged", async () => {
    await importFailingWith(new Error("socket hang up"));
    expect(
      await screen.findByText("Import failed — your data was not changed. socket hang up"),
    ).toBeInTheDocument();
    expect(useNimbusStore.getState().importFlow).toMatchObject({
      status: "error",
      errorKind: "rpc_failed",
      errorMessage: "socket hang up",
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("heading", { name: "Unlock the backup" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Passphrase")).toHaveValue("demo-passphrase");
  });

  it("reports an unclassified JSON-RPC code as a generic retryable failure", async () => {
    await importFailingWith(new JsonRpcError({ code: -32603, message: "internal error" }));
    expect(
      await screen.findByText("Import failed — your data was not changed. internal error"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/corrupt or tampered/)).toBeNull();
    expect(screen.queryByText(/Could not decrypt/)).toBeNull();
    expect(useNimbusStore.getState().importFlow.errorKind).toBe("rpc_failed");
  });

  // The real client always rejects with an Error (parseError), so this guards the wizard's own
  // contract: a rejection that carries no message is stored as `null`, never `undefined`.
  it("records a null error message for a rejection that is not an Error", async () => {
    await importFailingWith({ code: "EIO" });
    await screen.findByRole("heading", { name: "Restore failed" });
    const flow = useNimbusStore.getState().importFlow;
    expect(flow).toMatchObject({ status: "error", errorKind: "rpc_failed" });
    expect(flow.errorMessage).toBeNull();
    expect(screen.getByText(/^Import failed — your data was not changed\./)).toBeInTheDocument();
    expect(screen.queryByText(/corrupt or tampered/)).toBeNull();
    expect(screen.queryByText(/Could not decrypt/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("closes from the retryable error step", async () => {
    dataImportMock.mockRejectedValue(new Error("boom"));
    const onClose = vi.fn();
    renderWizard(onClose);
    await toAuth();
    toConfirmWithPassphrase();
    await confirmImport();
    await screen.findByRole("heading", { name: "Restore failed" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ImportWizard — progress and completion", () => {
  it("drives the progress bar from data.importProgress only", async () => {
    dataImportMock.mockImplementation(() => new Promise(() => {}));
    renderWizard();
    await waitFor(() => expect(listeners.get("gateway://notification")).toHaveLength(1));
    await toAuth();
    toConfirmWithPassphrase();
    await confirmImport();

    expect(screen.getByRole("heading", { name: "Restoring backup…" })).toBeInTheDocument();
    expect(screen.getByText("Stage: starting")).toBeInTheDocument();
    expect(screen.getByTestId("import-progress-indeterminate")).toBeInTheDocument();
    expect(useNimbusStore.getState().importFlow.status).toBe("running");

    fireNotification("data.exportProgress", { stage: "packing", bytesWritten: 1, totalBytes: 2 });
    expect(screen.getByText("Stage: starting")).toBeInTheDocument();

    fireNotification("data.importProgress", { stage: "decrypting", bytesRead: 30, totalBytes: 60 });
    expect(screen.getByText("Stage: decrypting")).toBeInTheDocument();
    expect(screen.getByTestId("import-progress-bar")).toHaveAttribute("value", "50");

    fireNotification("data.importProgress", { stage: "restoring", bytesRead: 90, totalBytes: 60 });
    expect(screen.getByTestId("import-progress-bar")).toHaveAttribute("value", "100");

    fireNotification("data.importProgress", { stage: "indexing", bytesRead: 5, totalBytes: 0 });
    expect(screen.getByTestId("import-progress-indeterminate")).toBeInTheDocument();
    expect(screen.getByText("Stage: indexing")).toBeInTheDocument();
  });

  it("uses singular copy for one OAuth connector and plural for zero credentials, then reloads", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...globalThis.location, reload });
    dataImportMock.mockResolvedValue({ credentialsRestored: 0, oauthEntriesFlagged: 1 });
    renderWizard();
    await toAuth();
    toConfirmWithPassphrase();
    vi.useFakeTimers();
    await confirmImport();

    expect(screen.getByRole("heading", { name: "Restore complete" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Restoring backup…" })).toBeNull();
    expect(screen.getByText("Restored 0 credentials.")).toBeInTheDocument();
    expect(screen.getByText(/1 OAuth connector need/)).toBeInTheDocument();
    expect(screen.queryByText(/OAuth connectors/)).toBeNull();
    expect(useNimbusStore.getState().importFlow.status).toBe("idle");

    act(() => {
      vi.advanceTimersByTime(2_999);
    });
    expect(reload).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("omits the OAuth line when nothing needs re-authorization", async () => {
    vi.stubGlobal("location", { ...globalThis.location, reload: vi.fn() });
    dataImportMock.mockResolvedValue({ credentialsRestored: 1, oauthEntriesFlagged: 0 });
    renderWizard();
    await toAuth();
    toConfirmWithPassphrase();
    vi.useFakeTimers();
    await confirmImport();
    expect(screen.getByText("Restored 1 credential.")).toBeInTheDocument();
    expect(screen.queryByText(/OAuth connector/)).toBeNull();
    expect(dataImportMock).toHaveBeenCalledWith({
      bundlePath: BUNDLE,
      passphrase: "demo-passphrase",
    });
  });
});
