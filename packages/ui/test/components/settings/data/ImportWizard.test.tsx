import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportWizard } from "../../../../src/components/settings/data/ImportWizard";
import { dataImportMock } from "../../../../src/ipc/__mocks__/client";
import { JsonRpcError } from "../../../../src/ipc/types";
import { useNimbusStore } from "../../../../src/store";

vi.mock("../../../../src/ipc/client");
const openMock = vi.fn<() => Promise<string | null>>();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...(args as [])),
}));

const navigateMock = vi.fn<(to: string) => void>();
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useNavigate: () => navigateMock };
});

function resetStore() {
  useNimbusStore.setState({
    importFlow: { status: "idle" },
    setImportFlow: (patch: Record<string, unknown>) =>
      useNimbusStore.setState((s) => ({
        importFlow: { ...s.importFlow, ...patch },
      })),
    setImportProgress: (progress: unknown) =>
      useNimbusStore.setState(
        (s) =>
          ({
            importFlow: { ...s.importFlow, progress },
          }) as never,
      ),
  } as never);
}

async function toConfirmStep(
  user: ReturnType<typeof userEvent.setup>,
  method: "passphrase" | "recoverySeed" = "passphrase",
) {
  openMock.mockResolvedValue("/mock-input/nimbus.tar.gz");
  render(<ImportWizard onClose={() => {}} />);
  await user.click(screen.getByRole("button", { name: /Choose file/ }));
  if (method === "recoverySeed") {
    await user.click(screen.getByRole("radio", { name: /Recovery seed/ }));
    const inputs = screen.getAllByRole("textbox");
    for (let i = 0; i < 12; i++) {
      await user.type(inputs[i] as HTMLElement, "abandon");
    }
  } else {
    await user.type(screen.getByPlaceholderText(/Passphrase/), "demo-passphrase");
  }
  await user.click(screen.getByRole("button", { name: "Next" }));
}

describe("ImportWizard — happy path + reload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("shows oauthEntriesFlagged copy when > 0 and triggers reload after 3 s", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal("location", { ...globalThis.location, reload });
    dataImportMock.mockResolvedValue({ credentialsRestored: 4, oauthEntriesFlagged: 2 });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    openMock.mockResolvedValue("/mock-input/nimbus.tar.gz");
    render(<ImportWizard onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Choose file/ }));
    await vi.waitFor(() => {
      expect(screen.getByPlaceholderText(/Passphrase/)).toBeInTheDocument();
    });
    await user.type(screen.getByPlaceholderText(/Passphrase/), "demo-passphrase");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await vi.waitFor(() => {
      expect(screen.getByPlaceholderText("replace my data")).toBeInTheDocument();
    });
    await user.type(screen.getByPlaceholderText("replace my data"), "replace my data");
    await user.click(screen.getByRole("button", { name: /Replace my data/ }));
    await vi.waitFor(() => {
      expect(screen.getByText(/Restore complete/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/2 OAuth connectors need re-authorization/i)).toBeInTheDocument();
    vi.advanceTimersByTime(3000);
    expect(reload).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("ImportWizard — error paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("-32010 archive_newer → terminal dialog with 'Update Nimbus' copy + Go-to-Updates deep link", async () => {
    dataImportMock.mockRejectedValue(
      new JsonRpcError({
        code: -32010,
        message: "version mismatch",
        data: {
          kind: "version_incompatible",
          archiveSchemaVersion: 99,
          currentSchemaVersion: 17,
          relation: "archive_newer",
        },
      }),
    );
    const user = userEvent.setup();
    await toConfirmStep(user, "passphrase");
    await user.type(screen.getByPlaceholderText("replace my data"), "replace my data");
    await user.click(screen.getByRole("button", { name: /Replace my data/ }));
    await vi.waitFor(() => {
      expect(screen.getByText(/newer Nimbus/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    const goBtn = screen.getByRole("button", { name: /Go to Updates/ });
    await user.click(goBtn);
    expect(navigateMock).toHaveBeenCalledWith("/settings/updates");
  });

  it("-32010 archive_older_unsupported → no Go-to-Updates button", async () => {
    dataImportMock.mockRejectedValue(
      new JsonRpcError({
        code: -32010,
        message: "version mismatch",
        data: {
          kind: "version_incompatible",
          archiveSchemaVersion: 1,
          currentSchemaVersion: 17,
          relation: "archive_older_unsupported",
        },
      }),
    );
    const user = userEvent.setup();
    await toConfirmStep(user, "passphrase");
    await user.type(screen.getByPlaceholderText("replace my data"), "replace my data");
    await user.click(screen.getByRole("button", { name: /Replace my data/ }));
    await vi.waitFor(() => {
      expect(screen.getByText(/older, unsupported Nimbus/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Go to Updates/ })).not.toBeInTheDocument();
  });

  it("-32002 decryption_failed shows retryable inline error", async () => {
    dataImportMock.mockRejectedValue(
      new JsonRpcError({ code: -32002, message: "decryption failed" }),
    );
    const user = userEvent.setup();
    await toConfirmStep(user, "passphrase");
    await user.type(screen.getByPlaceholderText("replace my data"), "replace my data");
    await user.click(screen.getByRole("button", { name: /Replace my data/ }));
    await vi.waitFor(() => {
      expect(screen.getByText(/Could not decrypt with that passphrase/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});

describe("ImportWizard — typed confirmation gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("blocks Replace when the phrase is wrong, enables when exact", async () => {
    const user = userEvent.setup();
    await toConfirmStep(user, "passphrase");
    const btn = screen.getByRole("button", { name: /Replace my data/ });
    expect(btn).toBeDisabled();
    await user.type(screen.getByPlaceholderText("replace my data"), "wrong phrase");
    expect(btn).toBeDisabled();
    await user.clear(screen.getByPlaceholderText("replace my data"));
    await user.type(screen.getByPlaceholderText("replace my data"), "replace my data");
    expect(btn).not.toBeDisabled();
  });
});

describe("ImportWizard — recovery seed auth method", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("accepts a 12-word recovery seed and submits import", async () => {
    dataImportMock.mockResolvedValue({ credentialsRestored: 1, oauthEntriesFlagged: 0 });
    const user = userEvent.setup();
    await toConfirmStep(user, "recoverySeed");
    await user.type(screen.getByPlaceholderText("replace my data"), "replace my data");
    await user.click(screen.getByRole("button", { name: /Replace my data/ }));
    await vi.waitFor(() => {
      expect(screen.getByText(/Restore complete/i)).toBeInTheDocument();
    });
    expect(dataImportMock).toHaveBeenCalledWith(
      expect.objectContaining({ recoverySeed: expect.stringContaining("abandon") }),
    );
  });

  it("-32002 with recoverySeed shows seed-specific error copy", async () => {
    dataImportMock.mockRejectedValue(
      new JsonRpcError({ code: -32002, message: "decryption failed" }),
    );
    const user = userEvent.setup();
    await toConfirmStep(user, "recoverySeed");
    await user.type(screen.getByPlaceholderText("replace my data"), "replace my data");
    await user.click(screen.getByRole("button", { name: /Replace my data/ }));
    await vi.waitFor(() => {
      expect(screen.getByText(/Could not decrypt with that recovery seed/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});
