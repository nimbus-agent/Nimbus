import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportWizard } from "../../../../src/components/settings/data/ExportWizard";
import { dataExportMock } from "../../../../src/ipc/__mocks__/client";
import { useNimbusStore } from "../../../../src/store";

vi.mock("../../../../src/ipc/client");

const saveMock = vi.fn<() => Promise<string | null>>();
const existsMock = vi.fn<() => Promise<boolean>>();
const writeTextMock = vi.fn<(text: string) => Promise<void>>();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...(args as [])),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: (...args: unknown[]) => existsMock(...(args as [])),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string) => writeTextMock(text),
  open: () => undefined,
}));

function resetStore() {
  useNimbusStore.setState({
    connectionState: "connected",
    exportFlow: { status: "idle" },
    setExportFlow: (patch: Record<string, unknown>) =>
      useNimbusStore.setState((s) => ({
        exportFlow: { ...s.exportFlow, ...patch },
      })),
    setExportProgress: (progress: unknown) =>
      useNimbusStore.setState(
        (s) =>
          ({
            exportFlow: { ...s.exportFlow, progress },
          }) as never,
      ),
  } as never);
}

type UserActions = Pick<typeof userEvent, "click" | "type">;

async function advanceToDestination(user: UserActions = userEvent): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.type(
    screen.getAllByPlaceholderText(/assphrase/)[0] as HTMLInputElement,
    "reasonably-strong-example-phrase!",
  );
  await user.type(
    screen.getAllByPlaceholderText(/Confirm/)[0] as HTMLInputElement,
    "reasonably-strong-example-phrase!",
  );
  const nextBtns = screen.getAllByRole("button", { name: "Next" });
  await user.click(nextBtns[nextBtns.length - 1] as HTMLElement);
  await user.click(screen.getByRole("button", { name: /Choose file/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("ExportWizard — passphrase gate", () => {
  it("blocks Next when zxcvbn score < 3", async () => {
    render(<ExportWizard onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    const input = screen.getAllByPlaceholderText(/assphrase/)[0] as HTMLInputElement;
    const confirm = screen.getAllByPlaceholderText(/Confirm/)[0] as HTMLInputElement;
    await userEvent.type(input, "password1234");
    await userEvent.type(confirm, "password1234");
    const nextBtns = screen.getAllByRole("button", { name: "Next" });
    const next = nextBtns[nextBtns.length - 1] as HTMLButtonElement;
    expect(next).toBeDisabled();
  });

  it("allows Next when zxcvbn score >= 3 and passphrase === confirm and length >= 12", async () => {
    render(<ExportWizard onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    const input = screen.getAllByPlaceholderText(/assphrase/)[0] as HTMLInputElement;
    const confirm = screen.getAllByPlaceholderText(/Confirm/)[0] as HTMLInputElement;
    await userEvent.type(input, "reasonably-strong-example-phrase!");
    await userEvent.type(confirm, "reasonably-strong-example-phrase!");
    const nextBtns = screen.getAllByRole("button", { name: "Next" });
    const next = nextBtns[nextBtns.length - 1] as HTMLButtonElement;
    expect(next).not.toBeDisabled();
  });
});

describe("ExportWizard — destination + overwrite", () => {
  it("save dialog is called with a YYYY-MM-DD default filename", async () => {
    saveMock.mockResolvedValue(null);
    render(<ExportWizard onClose={() => {}} />);
    await advanceToDestination();
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^nimbus-backup-\d{4}-\d{2}-\d{2}\.tar\.gz$/),
      }),
    );
  });

  it("shows overwrite sub-step when exists() returns true", async () => {
    saveMock.mockResolvedValue("/mock-output/existing.tar.gz");
    existsMock.mockResolvedValue(true);
    render(<ExportWizard onClose={() => {}} />);
    await advanceToDestination();
    await vi.waitFor(() => {
      expect(screen.getByText(/already exists/i)).toBeInTheDocument();
    });
  });
});

describe("ExportWizard — progress bar", () => {
  it("renders the indeterminate bar when totalBytes is undefined", async () => {
    useNimbusStore.setState({
      exportFlow: {
        status: "running",
        progress: { stage: "packing", bytesWritten: 100, totalBytes: undefined },
      },
    });
    dataExportMock.mockImplementation(() => new Promise(() => {}));
    saveMock.mockResolvedValue("/mock-output/nimbus.tar.gz");
    existsMock.mockResolvedValue(false);
    render(<ExportWizard onClose={() => {}} />);
    await advanceToDestination();
    await vi.waitFor(() => {
      expect(screen.getByTestId("export-progress-indeterminate")).toBeInTheDocument();
    });
  });

  it("renders the determinate bar when totalBytes is present", async () => {
    useNimbusStore.setState({
      exportFlow: {
        status: "running",
        progress: { stage: "packing", bytesWritten: 50, totalBytes: 100 },
      },
    });
    dataExportMock.mockImplementation(() => new Promise(() => {}));
    saveMock.mockResolvedValue("/mock-output/nimbus.tar.gz");
    existsMock.mockResolvedValue(false);
    render(<ExportWizard onClose={() => {}} />);
    await advanceToDestination();
    await vi.waitFor(() => {
      expect(screen.getByTestId("export-progress-bar")).toBeInTheDocument();
    });
  });
});

describe("ExportWizard — seed branching", () => {
  beforeEach(() => {
    saveMock.mockResolvedValue("/mock-output/nimbus.tar.gz");
    existsMock.mockResolvedValue(false);
  });

  async function stepToSeed(generated: boolean) {
    dataExportMock.mockResolvedValue({
      outputPath: "/mock-output/nimbus.tar.gz",
      recoverySeed:
        "abandon ability able about above absent absorb abstract absurd abuse access accident",
      recoverySeedGenerated: generated,
      itemsExported: 7,
    });
    render(<ExportWizard onClose={() => {}} />);
    await advanceToDestination();
  }

  it("first-time: shows mnemonic + 'Nimbus cannot recover' warning + gated checkbox", async () => {
    await stepToSeed(true);
    await vi.waitFor(() => {
      expect(screen.getByTestId("recovery-seed")).toBeInTheDocument();
    });
    expect(screen.getByText(/Nimbus cannot recover/i)).toBeInTheDocument();
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox"));
    expect(done).not.toBeDisabled();
  });

  it("re-export: shows reminder card without mnemonic", async () => {
    await stepToSeed(false);
    await vi.waitFor(() => {
      expect(screen.queryByTestId("recovery-seed")).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Your recovery seed hasn't changed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).not.toBeDisabled();
  });
});

describe("ExportWizard — clipboard countdown and unmount scrubs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saveMock.mockResolvedValue("/mock-output/nimbus.tar.gz");
    existsMock.mockResolvedValue(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("countdown fires writeText('') after 30 s", async () => {
    dataExportMock.mockResolvedValue({
      outputPath: "/mock-output/nimbus.tar.gz",
      recoverySeed: "one two three four five six seven eight nine ten eleven twelve",
      recoverySeedGenerated: true,
      itemsExported: 1,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ExportWizard onClose={() => {}} />);
    await advanceToDestination(user);
    await vi.waitFor(() => {
      expect(screen.getByTestId("recovery-seed")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeTextMock).toHaveBeenCalledWith(
      "one two three four five six seven eight nine ten eleven twelve",
    );
    vi.advanceTimersByTime(30_000);
    expect(writeTextMock).toHaveBeenCalledWith("");
  });

  it("unmounting during active countdown clears clipboard immediately", async () => {
    dataExportMock.mockResolvedValue({
      outputPath: "/mock-output/nimbus.tar.gz",
      recoverySeed: "one two three four five six seven eight nine ten eleven twelve",
      recoverySeedGenerated: true,
      itemsExported: 1,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = render(<ExportWizard onClose={() => {}} />);
    await advanceToDestination(user);
    await vi.waitFor(() => {
      expect(screen.getByTestId("recovery-seed")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Copy" }));
    writeTextMock.mockClear();
    unmount();
    expect(writeTextMock).toHaveBeenCalledWith("");
  });
});
