import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listeners, saveMock, existsMock, writeTextMock, clipboard } = vi.hoisted(() => ({
  listeners: new Map<string, Array<(payload: unknown) => void>>(),
  saveMock: vi.fn<(opts: unknown) => Promise<string | null>>(),
  existsMock: vi.fn<(path: string) => Promise<boolean>>(),
  // Records clipboard writes only; the promise the wizard receives comes from the plain wrapper in
  // the module mock below. vi.fn attaches settle handlers to every promise it returns (for
  // mock.settledResults), so a rejection returned by the spy itself would always count as handled
  // and a missing `.catch` around the scrub could never surface as an unhandled rejection.
  writeTextMock: vi.fn<(text: string) => void>(),
  clipboard: { failScrub: false },
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
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: existsMock }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string): Promise<void> => {
    writeTextMock(text);
    return clipboard.failScrub && text === ""
      ? Promise.reject(new Error("clipboard unavailable"))
      : Promise.resolve();
  },
}));

import { ExportWizard } from "../../../../src/components/settings/data/ExportWizard";
import { dataExportMock } from "../../../../src/ipc/__mocks__/client";
import { useNimbusStore } from "../../../../src/store";

const PHRASE = "reasonably-strong-example-phrase!";
const OUT = "/mock-output/nimbus.tar.gz";
const SEED = "one two three four five six seven eight nine ten eleven twelve";

function fireNotification(method: string, params: unknown): void {
  for (const h of listeners.get("gateway://notification") ?? []) {
    act(() => h({ method, params }));
  }
}

/** Scope → passphrase → destination, without the per-keystroke cost of userEvent.type. */
function advanceToDestination(): void {
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.change(screen.getByPlaceholderText("Passphrase"), { target: { value: PHRASE } });
  fireEvent.change(screen.getByPlaceholderText("Confirm passphrase"), {
    target: { value: PHRASE },
  });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("heading", { name: "Choose destination" })).toBeInTheDocument();
}

beforeEach(() => {
  listeners.clear();
  saveMock.mockReset();
  existsMock.mockReset();
  writeTextMock.mockReset();
  clipboard.failScrub = false;
  dataExportMock.mockReset();
  useNimbusStore.setState({
    connectionState: "connected",
    exportFlow: { status: "idle", progress: null, errorKind: null, errorMessage: null },
  });
});

afterEach(() => {
  // Unmount while any fake timers are still installed, so the wizard's unmount scrub clears the
  // fake interval/timeout ids it created rather than whatever real timers share those ids.
  cleanup();
  vi.useRealTimers();
});

describe("ExportWizard — scope and navigation", () => {
  it("forwards an unchecked include-index box to data.export", async () => {
    saveMock.mockResolvedValue(OUT);
    existsMock.mockResolvedValue(false);
    dataExportMock.mockResolvedValue({
      outputPath: OUT,
      recoverySeed: SEED,
      recoverySeedGenerated: false,
      itemsExported: 1,
    });
    render(<ExportWizard onClose={() => {}} />);

    const box = screen.getByRole("checkbox", { name: /Include search index/ });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(box).not.toBeChecked();

    advanceToDestination();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByRole("heading", { name: "Backup saved" });
    expect(dataExportMock).toHaveBeenCalledWith({
      output: OUT,
      passphrase: PHRASE,
      includeIndex: false,
    });
    // The finished export hands the flow back (DataPanel locks its sibling flows while it runs)
    // and shows only the final step.
    expect(useNimbusStore.getState().exportFlow.status).toBe("idle");
    expect(screen.queryByRole("heading", { name: "Creating backup…" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Export failed" })).toBeNull();
  });

  it("walks backwards through the steps and keeps the typed passphrase", () => {
    render(<ExportWizard onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Backup scope" })).toBeInTheDocument();

    advanceToDestination();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Choose a passphrase" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Passphrase")).toHaveValue(PHRASE);
    expect(screen.getByPlaceholderText("Confirm passphrase")).toHaveValue(PHRASE);
  });

  it("calls onClose from the scope step's Cancel", () => {
    const onClose = vi.fn();
    render(<ExportWizard onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ExportWizard — passphrase gate", () => {
  function toPassphraseStep(): void {
    render(<ExportWizard onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
  }

  function typePassphrase(passphrase: string, confirmation = passphrase): void {
    fireEvent.change(screen.getByPlaceholderText("Passphrase"), { target: { value: passphrase } });
    fireEvent.change(screen.getByPlaceholderText("Confirm passphrase"), {
      target: { value: confirmation },
    });
  }

  // Strength scores below are zxcvbn's own: "Xq7!vR2#mK9" and "Xq7!vR2#mK9z" rate 4 (Strong),
  // "bluehorse123" rates exactly 3 (Good), "correcthorse" 2 (Fair), "password1234" 1 (Weak).
  it.each([
    ["is one character short of 12, however strong", "Xq7!vR2#mK9", "Xq7!vR2#mK9"],
    ["does not match its confirmation", "Xq7!vR2#mK9z", "Xq7!vR2#mK9Z"],
    ["is long enough but only rated Fair", "correcthorse", "correcthorse"],
  ])("keeps Next disabled while the passphrase %s", (_label, passphrase, confirmation) => {
    toPassphraseStep();
    typePassphrase(passphrase, confirmation);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it.each([
    ["exactly 12 characters long", "Xq7!vR2#mK9z"],
    ["rated exactly Good", "bluehorse123"],
  ])("enables Next for a confirmed passphrase that is %s", (_label, passphrase) => {
    toPassphraseStep();
    typePassphrase(passphrase);
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();
  });

  it.each([
    ["", "Very weak"],
    ["password1234", "Weak"],
    ["correcthorse", "Fair"],
    ["bluehorse123", "Good"],
    ["Xq7!vR2#mK9z", "Strong"],
  ])("labels the passphrase %j as %s", (passphrase, label) => {
    toPassphraseStep();
    fireEvent.change(screen.getByPlaceholderText("Passphrase"), { target: { value: passphrase } });
    expect(screen.getByTestId("zxcvbn-score").textContent).toBe(`Strength: ${label}`);
  });
});

describe("ExportWizard — destination", () => {
  it("defaults the file name to today's zero-padded date and offers only .tar.gz", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 2, 5, 9, 30));
    saveMock.mockResolvedValue(null);
    render(<ExportWizard onClose={() => {}} />);
    advanceToDestination();
    expect(screen.getByText(/A save dialog will open/).textContent).toBe(
      "A save dialog will open. The file defaults to nimbus-backup-2026-03-05.tar.gz.",
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    });
    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "nimbus-backup-2026-03-05.tar.gz",
      filters: [{ name: "Nimbus backup", extensions: ["tar.gz"] }],
    });
    // Dismissing the dialog stays on the destination step and starts nothing.
    expect(screen.getByRole("heading", { name: "Choose destination" })).toBeInTheDocument();
    expect(existsMock).not.toHaveBeenCalled();
    expect(dataExportMock).not.toHaveBeenCalled();
  });
});

describe("ExportWizard — overwrite prompt", () => {
  beforeEach(() => {
    saveMock.mockResolvedValue("/mock-output/existing.tar.gz");
    existsMock.mockResolvedValue(true);
  });

  it("returns to the destination step on Cancel without exporting", async () => {
    render(<ExportWizard onClose={() => {}} />);
    advanceToDestination();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByRole("heading", { name: "File already exists" });
    expect(screen.getByText("/mock-output/existing.tar.gz")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Choose destination" })).toBeInTheDocument();
    expect(dataExportMock).not.toHaveBeenCalled();
  });

  it("exports to the existing path once the overwrite is confirmed", async () => {
    dataExportMock.mockResolvedValue({
      outputPath: "/mock-output/existing.tar.gz",
      recoverySeed: SEED,
      recoverySeedGenerated: true,
      itemsExported: 3,
    });
    render(<ExportWizard onClose={() => {}} />);
    advanceToDestination();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Overwrite" }));

    expect(await screen.findByTestId("recovery-seed")).toHaveTextContent(SEED);
    expect(dataExportMock).toHaveBeenCalledTimes(1);
    expect(dataExportMock).toHaveBeenCalledWith({
      output: "/mock-output/existing.tar.gz",
      passphrase: PHRASE,
      includeIndex: true,
    });
    expect(screen.queryByRole("heading", { name: "File already exists" })).toBeNull();
  });

  it("names the overwritten file as the possible partial file when that export fails", async () => {
    dataExportMock.mockRejectedValue(new Error("disk full"));
    render(<ExportWizard onClose={() => {}} />);
    advanceToDestination();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Overwrite" }));

    await screen.findByRole("heading", { name: "Export failed" });
    expect(screen.getByText(/disk full/).textContent).toBe(
      "disk full A partial file may exist at /mock-output/existing.tar.gz — delete it before retrying.",
    );
  });
});

describe("ExportWizard — failure", () => {
  it("shows the error step with the partial-file hint and records the flow error", async () => {
    saveMock.mockResolvedValue(OUT);
    existsMock.mockResolvedValue(false);
    dataExportMock.mockRejectedValue(new Error("disk full"));
    const onClose = vi.fn();
    render(<ExportWizard onClose={onClose} />);
    advanceToDestination();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));

    await screen.findByRole("heading", { name: "Export failed" });
    const body = screen.getByText(/disk full/);
    expect(body.textContent).toBe(
      `disk full A partial file may exist at ${OUT} — delete it before retrying.`,
    );
    expect(useNimbusStore.getState().exportFlow).toMatchObject({
      status: "error",
      errorKind: "rpc_failed",
      errorMessage: "disk full",
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ExportWizard — progress notifications", () => {
  it("drives the bar from data.exportProgress and ignores other notifications", async () => {
    saveMock.mockResolvedValue(OUT);
    existsMock.mockResolvedValue(false);
    dataExportMock.mockImplementation(() => new Promise(() => {}));
    render(<ExportWizard onClose={() => {}} />);
    await waitFor(() => expect(listeners.get("gateway://notification")).toHaveLength(1));
    advanceToDestination();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));

    await screen.findByRole("heading", { name: "Creating backup…" });
    expect(screen.getByText("Stage: starting")).toBeInTheDocument();
    expect(screen.getByTestId("export-progress-indeterminate")).toBeInTheDocument();
    expect(useNimbusStore.getState().exportFlow.status).toBe("running");

    fireNotification("data.importProgress", { stage: "decrypting", bytesRead: 1, totalBytes: 2 });
    expect(screen.getByText("Stage: starting")).toBeInTheDocument();
    expect(useNimbusStore.getState().exportFlow.progress).toBeNull();

    fireNotification("data.exportProgress", {
      stage: "encrypting",
      bytesWritten: 25,
      totalBytes: 100,
    });
    expect(screen.getByText("Stage: encrypting")).toBeInTheDocument();
    expect(screen.getByTestId("export-progress-bar")).toHaveAttribute("value", "25");

    // Over-reporting never pushes the bar past 100 %.
    fireNotification("data.exportProgress", {
      stage: "finalising",
      bytesWritten: 300,
      totalBytes: 100,
    });
    expect(screen.getByTestId("export-progress-bar")).toHaveAttribute("value", "100");

    // totalBytes of zero means "unknown size", so the bar goes back to indeterminate.
    fireNotification("data.exportProgress", { stage: "flushing", bytesWritten: 5, totalBytes: 0 });
    expect(screen.getByTestId("export-progress-indeterminate")).toBeInTheDocument();
    expect(screen.queryByTestId("export-progress-bar")).toBeNull();
  });
});

describe("ExportWizard — clipboard ownership on close", () => {
  async function toSeedStep(): Promise<() => void> {
    saveMock.mockResolvedValue(OUT);
    existsMock.mockResolvedValue(false);
    dataExportMock.mockResolvedValue({
      outputPath: OUT,
      recoverySeed: SEED,
      recoverySeedGenerated: true,
      itemsExported: 1,
    });
    const { unmount } = render(<ExportWizard onClose={() => {}} />);
    advanceToDestination();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByTestId("recovery-seed");
    return unmount;
  }

  /** Clipboard writes that clear it, as opposed to the one that copies the seed. */
  function scrubs(): number {
    return writeTextMock.mock.calls.filter(([text]) => text === "").length;
  }

  it("leaves the user's clipboard alone on close when the seed was never copied", async () => {
    const unmount = await toSeedStep();
    unmount();
    expect(writeTextMock).not.toHaveBeenCalled();
  });

  it("does not clear the clipboard again on close once the deadline already did", async () => {
    const unmount = await toSeedStep();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(scrubs()).toBe(1);

    // Whatever the user copied since then is theirs; closing must not wipe it.
    unmount();
    expect(scrubs()).toBe(1);
  });

  it("stops the countdown on close, so no clear fires after the wizard is gone", async () => {
    const unmount = await toSeedStep();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    unmount();
    expect(scrubs()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(scrubs()).toBe(1);
  });
});

describe("ExportWizard — clipboard countdown", () => {
  it("ticks down once per second and scrubs the clipboard at zero", async () => {
    saveMock.mockResolvedValue(OUT);
    existsMock.mockResolvedValue(false);
    dataExportMock.mockResolvedValue({
      outputPath: OUT,
      recoverySeed: SEED,
      recoverySeedGenerated: true,
      itemsExported: 1,
    });
    render(<ExportWizard onClose={() => {}} />);
    advanceToDestination();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByTestId("recovery-seed");

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(writeTextMock).toHaveBeenCalledWith(SEED);
    expect(screen.getByTestId("clipboard-countdown")).toHaveTextContent("Clipboard clears in 0:30");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("clipboard-countdown")).toHaveTextContent("Clipboard clears in 0:29");

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByTestId("clipboard-countdown")).toHaveTextContent("Clipboard clears in 0:09");
    expect(writeTextMock).not.toHaveBeenCalledWith("");

    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(writeTextMock).toHaveBeenLastCalledWith("");
    expect(screen.queryByTestId("clipboard-countdown")).toBeNull();
  });

  it("swallows a failing clipboard scrub, both at the deadline and on unmount", async () => {
    saveMock.mockResolvedValue(OUT);
    existsMock.mockResolvedValue(false);
    dataExportMock.mockResolvedValue({
      outputPath: OUT,
      recoverySeed: SEED,
      recoverySeedGenerated: true,
      itemsExported: 1,
    });
    // Copying works; clearing the clipboard is refused (e.g. the OS revoked access).
    clipboard.failScrub = true;
    const { unmount } = render(<ExportWizard onClose={() => {}} />);
    advanceToDestination();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByTestId("recovery-seed");

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(writeTextMock).toHaveBeenLastCalledWith("");
    expect(screen.queryByTestId("clipboard-countdown")).toBeNull();

    // A second copy leaves the clipboard "active", so unmount scrubs again — and that rejection is
    // swallowed too (an unhandled rejection here would fail the run).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    writeTextMock.mockClear();
    await act(async () => {
      unmount();
    });
    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith("");
  });

  it("restarts the countdown when Copy is pressed again", async () => {
    saveMock.mockResolvedValue(OUT);
    existsMock.mockResolvedValue(false);
    dataExportMock.mockResolvedValue({
      outputPath: OUT,
      recoverySeed: SEED,
      recoverySeedGenerated: true,
      itemsExported: 1,
    });
    render(<ExportWizard onClose={() => {}} />);
    advanceToDestination();
    fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByTestId("recovery-seed");

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(screen.getByTestId("clipboard-countdown")).toHaveTextContent("0:05");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(screen.getByTestId("clipboard-countdown")).toHaveTextContent("0:30");
    // The first copy's 30 s deadline (5 s away) must not scrub the fresh copy.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(writeTextMock).not.toHaveBeenCalledWith("");
    expect(screen.getByTestId("clipboard-countdown")).toHaveTextContent("0:20");
  });
});
