import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const consentRespond = vi.fn();
vi.mock("../../../src/ipc/client", () => ({
  createIpcClient: () => ({ consentRespond }),
}));

const storeState: {
  pending: Array<{
    requestId: string;
    prompt: string;
    details?: Record<string, unknown>;
    receivedAtMs: number;
    actionType?: string;
    confirmText?: string;
  }>;
  resolve: (id: string, ok: boolean) => void;
} = { pending: [], resolve: vi.fn() };

vi.mock("../../../src/store", () => ({
  useNimbusStore: (sel: (s: typeof storeState) => unknown) => sel(storeState),
}));

import { HitlPopupPage } from "../../../src/components/hitl/HitlPopupPage";

beforeEach(() => {
  invoke.mockReset();
  consentRespond.mockReset();
});

describe("HitlPopupPage", () => {
  it("renders 'No pending requests' when queue is empty", () => {
    storeState.pending = [];
    render(<HitlPopupPage />);
    expect(screen.getByText(/No pending requests/i)).toBeInTheDocument();
  });

  it("invokes close_hitl_popup after 500 ms when pending queue is empty", async () => {
    vi.useFakeTimers();
    storeState.pending = [];
    invoke.mockResolvedValue(undefined);
    render(<HitlPopupPage />);
    expect(invoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledWith("close_hitl_popup");
    vi.useRealTimers();
  });

  it("pack.install shows its prompt verbatim in a bounded scroll box, not as the heading", () => {
    const prompt = 'Install the Product pack?\n\n[agents]\nvisible = ["decisions"]\n';
    storeState.pending = [
      {
        requestId: "rp",
        prompt,
        details: { packId: "pm", promptText: prompt },
        receivedAtMs: 1,
        actionType: "pack.install",
      },
    ];
    render(<HitlPopupPage />);
    expect(screen.getByRole("heading", { name: "Install this role pack?" })).toBeInTheDocument();
    const box = screen.getByTestId("pack-install-prompt");
    expect(box.tagName).toBe("PRE");
    expect(box.textContent).toBe(prompt);
    expect(box.style.maxHeight).toBe("200px");
    expect(box.style.overflow).toBe("auto");
    // The structured preview would repeat the prompt text; it is not rendered for a pack install.
    expect(screen.queryByText("promptText")).toBeNull();
  });

  it("pack.install starts with focus on Reject", () => {
    storeState.pending = [
      { requestId: "rq", prompt: "x", receivedAtMs: 1, actionType: "pack.install" },
    ];
    render(<HitlPopupPage />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Reject/i }));
  });

  it("renders the head-of-queue prompt", () => {
    storeState.pending = [{ requestId: "r1", prompt: "Send message?", receivedAtMs: Date.now() }];
    render(<HitlPopupPage />);
    expect(screen.getByRole("heading", { name: /Send message\?/ })).toBeInTheDocument();
  });

  it("Approve dispatches consentRespond(id, true)", async () => {
    storeState.pending = [{ requestId: "r2", prompt: "p", receivedAtMs: 1 }];
    consentRespond.mockResolvedValue(undefined);
    render(<HitlPopupPage />);
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    await waitFor(() => expect(consentRespond).toHaveBeenCalledWith("r2", true));
  });

  it("Reject dispatches consentRespond(id, false)", async () => {
    storeState.pending = [{ requestId: "r3", prompt: "p", receivedAtMs: 1 }];
    consentRespond.mockResolvedValue(undefined);
    render(<HitlPopupPage />);
    fireEvent.click(screen.getByRole("button", { name: /Reject/i }));
    await waitFor(() => expect(consentRespond).toHaveBeenCalledWith("r3", false));
  });

  it("shows +N more pending when queue length > 1", () => {
    storeState.pending = [
      { requestId: "a", prompt: "p", receivedAtMs: 1 },
      { requestId: "b", prompt: "q", receivedAtMs: 2 },
      { requestId: "c", prompt: "r", receivedAtMs: 3 },
    ];
    render(<HitlPopupPage />);
    expect(screen.getByText(/\+2 more pending/)).toBeInTheDocument();
  });

  it("does NOT autoFocus Approve for destructive actions", () => {
    storeState.pending = [
      { requestId: "d", prompt: "Delete file?", receivedAtMs: 1, actionType: "data.delete" },
    ];
    render(<HitlPopupPage />);
    const approve = screen.getByRole("button", { name: /Approve/i });
    expect(document.activeElement).not.toBe(approve);
  });

  it("fails safe: focuses Reject when the gateway sent no action type", () => {
    storeState.pending = [{ requestId: "u", prompt: "Delete everything?", receivedAtMs: 1 }];
    render(<HitlPopupPage />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Reject/i }));
  });

  it("focuses Approve for a safe action", () => {
    storeState.pending = [
      { requestId: "s", prompt: "Read file?", receivedAtMs: 1, actionType: "data.export" },
    ];
    render(<HitlPopupPage />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Approve/i }));
  });

  /**
   * The popup does NOT remount between queued requests — it re-renders with `pending[0]` replaced.
   * React honours the `autoFocus` ATTRIBUTE only at mount, so the conditional this component used
   * to carry (`autoFocus={!isDestructive(action)}`) applied the deny-list to the FIRST request
   * only: a safe request followed by a destructive one left focus sitting on Approve, which is
   * exactly the keystroke the deny-list exists to prevent. Fails against that implementation.
   */
  it("moves focus OFF Approve when a destructive action replaces a safe one without remounting", () => {
    storeState.pending = [
      { requestId: "safe", prompt: "Read file?", receivedAtMs: 1, actionType: "data.export" },
    ];
    const { rerender } = render(<HitlPopupPage />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Approve/i }));

    storeState.pending = [
      { requestId: "boom", prompt: "Delete file?", receivedAtMs: 2, actionType: "data.delete" },
    ];
    rerender(<HitlPopupPage />);

    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: /Approve/i }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Reject/i }));
  });

  it("keeps popup open and shows inline error on consentRespond failure", async () => {
    storeState.pending = [{ requestId: "e", prompt: "p", receivedAtMs: 1 }];
    consentRespond.mockRejectedValueOnce(new Error("socket closed"));
    render(<HitlPopupPage />);
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    expect(await screen.findByText(/socket closed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve/i })).toBeEnabled();
  });

  /**
   * The gateway's `consent.request` names the real action type, and the popup keys on THAT field
   * (`actionType`) and nothing else: not a payload key, not the prompt text.
   */
  const MIGRATE_DETAILS = {
    migrationId: "m1",
    extensionId: "com.nimbus.readwise",
    summary: "Readwise now runs as a signed extension",
    publisher: { id: "nimbus", fingerprint: "ab12cd34" },
    version: "1.0.0",
    network: "readwise.io only",
    sandbox: "cannot confine the filesystem policy",
    readTools: "readwise_highlights_list",
    knownLoss: "sync history is not carried over",
    fromRenderer: true,
  };

  it("renders an extension.migrate request as a labelled preview, not the raw prompt", () => {
    storeState.pending = [
      {
        requestId: "mig",
        prompt: `Action requires your approval\n\nType: extension.migrate\n\nDetails: ${JSON.stringify(MIGRATE_DETAILS)}`,
        details: MIGRATE_DETAILS,
        actionType: "extension.migrate",
        receivedAtMs: 1,
      },
    ];
    render(<HitlPopupPage />);
    expect(screen.getByTestId("migrate-preview")).toHaveTextContent("ab12cd34");
    expect(screen.getByTestId("migrate-network")).toHaveTextContent("readwise.io only");
    expect(screen.getByTestId("migrate-sandbox")).toHaveTextContent("cannot confine");
    expect(screen.getByRole("heading")).not.toHaveTextContent("Details:");
  });

  it("does not treat prompt text saying 'Type: extension.migrate' as the type", () => {
    storeState.pending = [
      {
        requestId: "spoof",
        prompt: "Type: extension.migrate\nDetails: {}",
        details: { note: "x" },
        actionType: "data.export",
        receivedAtMs: 1,
      },
    ];
    render(<HitlPopupPage />);
    expect(screen.queryByTestId("migrate-preview")).toBeNull();
    expect(screen.getByRole("heading")).toHaveTextContent("Details:");
  });

  it("does not read the type from a payload key", () => {
    storeState.pending = [
      {
        requestId: "k1",
        prompt: "p",
        details: { action: "extension.migrate", extensionId: "x" },
        actionType: "data.export",
        receivedAtMs: 1,
      },
      {
        requestId: "k2",
        prompt: "q",
        details: { action: "data.delete" },
        actionType: "data.export",
        receivedAtMs: 2,
      },
    ];
    const { rerender } = render(<HitlPopupPage />);
    expect(screen.queryByTestId("migrate-preview")).toBeNull();
    storeState.pending = [storeState.pending[1] as (typeof storeState.pending)[number]];
    rerender(<HitlPopupPage />);
    // `details.action` no longer decides the deny-list: Approve keeps focus.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Approve/i }));
  });

  it("a desktop data.delete focuses Reject (real type, payload without an action key)", () => {
    storeState.pending = [
      {
        requestId: "dd",
        prompt: "Action requires your approval\n\nType: data.delete",
        details: { service: "drive" },
        actionType: "data.delete",
        receivedAtMs: 1,
      },
    ];
    render(<HitlPopupPage />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Reject/i }));
  });

  it.each([
    ["extension.autoUpdate", /Update extension/],
    ["extension.downgrade", /Roll back extension/],
  ])("renders the %s preview from the real type", (actionType, heading) => {
    storeState.pending = [
      {
        requestId: "au",
        prompt: "p",
        details: {
          displayName: "Notion",
          fromVersion: "1.0.0",
          toVersion: "1.1.0",
          channel: "stable",
          publisherStatus: "verified",
        },
        actionType,
        receivedAtMs: 1,
      },
    ];
    render(<HitlPopupPage />);
    expect(screen.getByTestId("auto-update-preview")).toHaveTextContent(heading);
  });
});

describe("HitlPopupPage: connector write preview", () => {
  const typed = {
    kind: "connector-write",
    service: "github",
    actionType: "github.issue.create",
    toolId: "github_issue_create",
    target: "acme/repo",
    summary: "Create an issue",
    fields: [],
    otherFields: [],
    destination: { service: "github" },
  };

  it("uses a fixed heading for a typed preview, not the multi-line prompt", () => {
    storeState.pending = [
      {
        requestId: "cw",
        prompt: "Create an issue\nline two",
        details: typed,
        receivedAtMs: 1,
        actionType: "github.issue.create",
      },
    ];
    render(<HitlPopupPage />);
    expect(
      screen.getByRole("heading", { name: "Approve this connector write?" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /line two/ })).toBeNull();
    expect(screen.getByTestId("connector-write-preview")).toBeInTheDocument();
  });

  it("keeps the prompt heading when the details name a different action", () => {
    storeState.pending = [
      {
        requestId: "cw2",
        prompt: "Close an issue",
        details: typed,
        receivedAtMs: 1,
        actionType: "github.issue.close",
      },
    ];
    render(<HitlPopupPage />);
    expect(screen.getByRole("heading", { name: "Close an issue" })).toBeInTheDocument();
    expect(screen.queryByTestId("connector-write-preview")).toBeNull();
  });
});

describe("HitlPopupPage type-to-confirm (Wave 4)", () => {
  const TEXT = "github/acme/api#42";
  const wave4 = (over: Record<string, unknown> = {}) => [
    {
      requestId: "w4",
      prompt: `Merge?

To approve, type exactly: ${TEXT}`,
      receivedAtMs: 1,
      actionType: "github.pr.merge",
      confirmText: TEXT,
      ...over,
    },
  ];

  it("shows the text and a labelled input, focuses the input, and disables Approve", () => {
    storeState.pending = wave4();
    render(<HitlPopupPage />);
    expect(screen.getByTestId("confirm-text")).toHaveTextContent(TEXT);
    const input = screen.getByLabelText(/Type the text above/i);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("button", { name: /Approve/i })).toBeDisabled();
  });

  it("focuses the input even for a non-destructive action type", () => {
    storeState.pending = wave4({ actionType: "data.export" });
    render(<HitlPopupPage />);
    expect(document.activeElement).toBe(screen.getByLabelText(/Type the text above/i));
  });

  it("enables Approve only on an exact match (no trim, no case fold) and forwards typed", async () => {
    storeState.pending = wave4();
    consentRespond.mockResolvedValue(undefined);
    render(<HitlPopupPage />);
    const input = screen.getByLabelText(/Type the text above/i);
    const approve = screen.getByRole("button", { name: /Approve/i });
    for (const wrong of [`${TEXT} `, ` ${TEXT}`, TEXT.toUpperCase(), TEXT.slice(0, -1)]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(approve).toBeDisabled();
    }
    fireEvent.change(input, { target: { value: TEXT } });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await waitFor(() => expect(consentRespond).toHaveBeenCalledWith("w4", true, TEXT));
  });

  it("Enter in the field never approves", () => {
    storeState.pending = wave4();
    render(<HitlPopupPage />);
    const input = screen.getByLabelText(/Type the text above/i);
    fireEvent.change(input, { target: { value: TEXT } });
    const notPrevented = fireEvent.keyDown(input, { key: "Enter" });
    expect(notPrevented).toBe(false);
    expect(consentRespond).not.toHaveBeenCalled();
  });

  it("Reject needs no text and sends an empty typed", async () => {
    storeState.pending = wave4();
    consentRespond.mockResolvedValue(undefined);
    render(<HitlPopupPage />);
    fireEvent.click(screen.getByRole("button", { name: /Reject/i }));
    await waitFor(() => expect(consentRespond).toHaveBeenCalledWith("w4", false, ""));
  });

  it("typed text does not carry over to the next queued request", () => {
    storeState.pending = wave4();
    const { rerender } = render(<HitlPopupPage />);
    fireEvent.change(screen.getByLabelText(/Type the text above/i), { target: { value: TEXT } });
    storeState.pending = wave4({ requestId: "w4b" });
    rerender(<HitlPopupPage />);
    expect(screen.getByLabelText(/Type the text above/i)).toHaveValue("");
    expect(screen.getByRole("button", { name: /Approve/i })).toBeDisabled();
  });

  it("a request with no confirmText shows no field and behaves as before", async () => {
    storeState.pending = [{ requestId: "plain", prompt: "p", receivedAtMs: 1 }];
    consentRespond.mockResolvedValue(undefined);
    render(<HitlPopupPage />);
    expect(screen.queryByLabelText(/Type the text above/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    await waitFor(() => expect(consentRespond).toHaveBeenCalledWith("plain", true));
  });
});

describe("HitlPopupPage with a commit diff (D1c)", () => {
  const TEXT = "github/commit acme/api@feat/x";
  const goodDiff = {
    files: [
      {
        path: "a.ts",
        state: "new",
        additions: 1,
        deletions: 0,
        hunks: [
          { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [{ op: "+", text: "x" }] },
        ],
      },
    ],
    additions: 1,
    deletions: 0,
  };
  const commit = (diff: unknown) => [
    {
      requestId: "c1",
      prompt: "Commit?",
      receivedAtMs: 1,
      actionType: "github.file.commit",
      confirmText: TEXT,
      details: {
        kind: "connector-write",
        service: "github",
        actionType: "github.file.commit",
        target: "acme/api@feat/x",
        summary: "Commit",
        fields: [],
        otherFields: [],
        destination: { service: "github" },
        diff,
      },
    },
  ];

  it("a readable diff is shown and Approve is still gated by the typed text alone", () => {
    storeState.pending = commit(goodDiff);
    render(<HitlPopupPage />);
    expect(screen.getByTestId("connector-write-diff")).toBeInTheDocument();
    const approve = screen.getByRole("button", { name: /Approve/i });
    expect(approve).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type the text above/i), { target: { value: TEXT } });
    expect(approve).toBeEnabled();
  });

  it.each([
    ["github.file.commit", "github/commit acme/api@feat/x"],
    ["gitlab.commit.create", "gitlab/commit acme/api@feat/x"],
  ])("%s with NO diff key keeps Approve disabled even with the exact text typed", (type, text) => {
    const req = commit(goodDiff)[0];
    if (req === undefined) throw new Error("the commit fixture is empty");
    const { diff: _omitted, ...details } = (req as { details: Record<string, unknown> }).details;
    storeState.pending = [{ ...req, actionType: type, confirmText: text, details }];
    render(<HitlPopupPage />);
    fireEvent.change(screen.getByLabelText(/Type the text above/i), { target: { value: text } });
    expect(screen.getByRole("button", { name: /Approve/i })).toBeDisabled();
  });

  it("a write that carries no diff by design is not held back by the rule", () => {
    const req = commit(goodDiff)[0];
    if (req === undefined) throw new Error("the commit fixture is empty");
    const { diff: _omitted, ...details } = (req as { details: Record<string, unknown> }).details;
    storeState.pending = [{ ...req, actionType: "github.pr.merge", details }];
    render(<HitlPopupPage />);
    fireEvent.change(screen.getByLabelText(/Type the text above/i), { target: { value: TEXT } });
    expect(screen.getByRole("button", { name: /Approve/i })).toBeEnabled();
  });

  it("a malformed diff keeps Approve disabled even with the exact text typed; Reject still works", async () => {
    storeState.pending = commit({ files: "not a list" });
    consentRespond.mockResolvedValue(undefined);
    render(<HitlPopupPage />);
    expect(screen.getByTestId("connector-write-diff-error")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Type the text above/i), { target: { value: TEXT } });
    expect(screen.getByRole("button", { name: /Approve/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Reject/i }));
    await waitFor(() => expect(consentRespond).toHaveBeenCalledWith("c1", false, ""));
  });
});

describe("HitlPopupPage with a plan-bound write (D2)", () => {
  const TEXT = "iac/apply /srv/infra/prod";
  const goodPlan = {
    lines: [
      "Deletes: 0, Replaces: 0, Creates: 1, Updates: 0",
      "End of plan: 1 changes (0 deletes, 0 replaces)",
    ],
    bytes: 90,
    sha256: "c".repeat(64),
  };
  const apply = (type: string, text: string, plan?: unknown) => [
    {
      requestId: "p1",
      prompt: "Apply?",
      receivedAtMs: 1,
      actionType: type,
      confirmText: text,
      details: {
        kind: "connector-write",
        service: "iac",
        actionType: type,
        target: "/srv/infra/prod",
        summary: "Apply",
        fields: [],
        otherFields: [],
        destination: { service: "iac" },
        ...(plan === undefined ? {} : { plan }),
      },
    },
  ];

  it("a readable plan is shown and Approve is gated by the typed text alone", () => {
    storeState.pending = apply("iac.terraform.apply", TEXT, goodPlan);
    render(<HitlPopupPage />);
    expect(screen.getByTestId("connector-write-plan")).toBeInTheDocument();
    const approve = screen.getByRole("button", { name: /Approve/i });
    expect(approve).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type the text above/i), { target: { value: TEXT } });
    expect(approve).toBeEnabled();
  });

  it.each([
    ["iac.terraform.apply", "iac/apply /srv/infra/prod"],
    ["iac.terraform.destroy", "iac/destroy /srv/infra/prod"],
    ["iac.cloudformation.deploy", "iac/deploy prod-stack"],
    ["kubernetes.manifest.apply", "kubernetes/apply prod/shop ConfigMap/cfg"],
  ])("%s with NO plan keeps Approve disabled even with the exact text typed", (type, text) => {
    storeState.pending = apply(type, text);
    render(<HitlPopupPage />);
    fireEvent.change(screen.getByLabelText(/Type the text above/i), { target: { value: text } });
    expect(screen.getByRole("button", { name: /Approve/i })).toBeDisabled();
  });

  it("a malformed plan keeps Approve disabled even with the exact text typed; Reject still works", async () => {
    storeState.pending = apply("iac.terraform.apply", TEXT, { lines: "nope" });
    consentRespond.mockResolvedValue(undefined);
    render(<HitlPopupPage />);
    expect(screen.getByTestId("connector-write-plan-error")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Type the text above/i), { target: { value: TEXT } });
    expect(screen.getByRole("button", { name: /Approve/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Reject/i }));
    await waitFor(() => expect(consentRespond).toHaveBeenCalledWith("p1", false, ""));
  });

  it.each([
    "iac.terraform.apply",
    "iac.terraform.destroy",
    "iac.cloudformation.deploy",
    "kubernetes.manifest.apply",
  ])("%s with a good plan but NO confirm text is never treated as matched", (type) => {
    const req = apply(type, "x", goodPlan)[0] as Record<string, unknown>;
    const { confirmText: _dropped, ...noConfirm } = req;
    storeState.pending = [noConfirm as never];
    render(<HitlPopupPage />);
    expect(screen.getByRole("button", { name: /Approve/i })).toBeDisabled();
  });

  it("a non-plan write with no confirm text is still approvable (the rule is for plan-bound types only)", () => {
    const req = apply("github.issue.create", "x")[0] as Record<string, unknown>;
    const { confirmText: _dropped, ...noConfirm } = req;
    storeState.pending = [noConfirm as never];
    render(<HitlPopupPage />);
    expect(screen.getByRole("button", { name: /Approve/i })).toBeEnabled();
  });
});

describe("HitlPopupPage edge paths", () => {
  it("ignores a failing close_hitl_popup once the queue is empty", async () => {
    vi.useFakeTimers();
    storeState.pending = [];
    invoke.mockRejectedValue(new Error("window already gone"));
    render(<HitlPopupPage />);
    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledWith("close_hitl_popup");
    vi.useRealTimers();
  });

  it("rejecting a type-to-confirm prompt sends an empty typed text, whatever was typed", async () => {
    const TEXT = "github/acme/api#42";
    storeState.pending = [
      {
        requestId: "rj",
        prompt: `Merge?\n\nTo approve, type exactly: ${TEXT}`,
        receivedAtMs: 1,
        actionType: "github.pr.merge",
        confirmText: TEXT,
      },
    ];
    consentRespond.mockResolvedValue(undefined);
    render(<HitlPopupPage />);
    fireEvent.change(screen.getByLabelText(/Type the text above/i), { target: { value: TEXT } });
    fireEvent.click(screen.getByRole("button", { name: /Reject/i }));
    await waitFor(() => expect(consentRespond).toHaveBeenCalledWith("rj", false, ""));
  });
});
