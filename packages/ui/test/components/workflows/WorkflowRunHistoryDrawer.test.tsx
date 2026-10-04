import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/ipc/client");

import { WorkflowRunHistoryDrawer } from "../../../src/components/workflows/WorkflowRunHistoryDrawer";
import { workflowListRunsMock } from "../../../src/ipc/__mocks__/client";

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "r1",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_000_200,
    durationMs: 200,
    status: "done",
    errorMsg: null,
    dryRun: false,
    paramsOverrideJson: null,
    triggeredBy: "user",
    ...overrides,
  };
}

function drawer(name: string, onClose: () => void = () => {}) {
  return (
    <MemoryRouter>
      <table>
        <tbody>
          <WorkflowRunHistoryDrawer workflowName={name} onClose={onClose} colSpan={3} />
        </tbody>
      </table>
    </MemoryRouter>
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  workflowListRunsMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("WorkflowRunHistoryDrawer — rendering", () => {
  it("requests the last 10 runs and shows a loading line until they arrive", async () => {
    const pending = deferred<unknown>();
    workflowListRunsMock.mockReturnValueOnce(pending.promise);
    render(drawer("alpha"));
    expect(workflowListRunsMock).toHaveBeenCalledWith("alpha", 10);
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ runs: [run()] });
    });
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByText("200 ms")).toBeInTheDocument();
    expect(screen.getByText(new Date(1_700_000_000_000).toLocaleString())).toBeInTheDocument();
    // A history with runs shows the table, never the empty-state line.
    expect(screen.getByText("Started")).toBeInTheDocument();
    expect(screen.queryByText("No runs yet.")).toBeNull();
  });

  it("colours and labels each status distinctly", async () => {
    workflowListRunsMock.mockResolvedValueOnce({
      runs: [
        run({ id: "a", status: "done" }),
        run({ id: "b", status: "error" }),
        run({ id: "c", status: "running", durationMs: null, finishedAt: null }),
        run({ id: "d", status: "done", dryRun: true }),
      ],
    });
    render(drawer("alpha"));

    const done = await screen.findByText("done");
    expect(done.className).toContain("text-green-700");
    expect(screen.getByText("error").className).toContain("text-red-600");
    const running = screen.getByText("running");
    expect(running.className).toContain("text-neutral-600");
    expect(running.className).not.toContain("text-green-700");
    const preview = screen.getByText("preview (done)");
    expect(preview.className).toContain("text-amber-600");
    expect(preview.className).toContain("italic");
  });

  it("shows an em dash for a run without a duration and links each run to its audit entry", async () => {
    workflowListRunsMock.mockResolvedValueOnce({
      runs: [run({ id: "run/with space", durationMs: null, status: "running" })],
    });
    render(drawer("alpha"));
    expect(await screen.findByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/ ms$/)).toBeNull();
    expect(screen.getByRole("link", { name: "View audit entry" })).toHaveAttribute(
      "href",
      "/settings/audit?runId=run%2Fwith%20space",
    );
  });

  it("shows the request error instead of the table", async () => {
    workflowListRunsMock.mockRejectedValueOnce(new Error("history store offline"));
    render(drawer("alpha"));
    expect(await screen.findByText("history store offline")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByText("Started")).toBeNull();
    expect(screen.queryByText("No runs yet.")).toBeNull();
  });

  it("stringifies a non-Error rejection", async () => {
    workflowListRunsMock.mockRejectedValueOnce("E_HISTORY");
    render(drawer("alpha"));
    expect(await screen.findByText("E_HISTORY")).toBeInTheDocument();
  });

  it("calls onClose from the Close button", async () => {
    workflowListRunsMock.mockResolvedValueOnce({ runs: [] });
    const onClose = vi.fn();
    render(drawer("alpha", onClose));
    await screen.findByText("No runs yet.");
    // An empty history shows the empty-state line only, without an empty table.
    expect(screen.queryByText("Started")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("WorkflowRunHistoryDrawer — switching workflows", () => {
  it("ignores a late response for the previous workflow", async () => {
    const alpha = deferred<unknown>();
    const beta = deferred<unknown>();
    workflowListRunsMock.mockReturnValueOnce(alpha.promise).mockReturnValueOnce(beta.promise);
    const { rerender } = render(drawer("alpha"));
    rerender(drawer("beta"));
    expect(workflowListRunsMock.mock.calls).toEqual([
      ["alpha", 10],
      ["beta", 10],
    ]);

    await act(async () => {
      beta.resolve({ runs: [run({ id: "b1", durationMs: 222 })] });
    });
    await act(async () => {
      alpha.resolve({ runs: [run({ id: "a1", durationMs: 111 })] });
    });
    expect(screen.getByText("222 ms")).toBeInTheDocument();
    expect(screen.queryByText("111 ms")).toBeNull();
  });

  it("ignores a late failure for the previous workflow", async () => {
    const alpha = deferred<unknown>();
    workflowListRunsMock
      .mockReturnValueOnce(alpha.promise)
      .mockResolvedValueOnce({ runs: [run({ durationMs: 333 })] });
    const { rerender } = render(drawer("alpha"));
    rerender(drawer("beta"));
    expect(await screen.findByText("333 ms")).toBeInTheDocument();

    await act(async () => {
      alpha.reject(new Error("alpha history failed"));
    });
    expect(screen.queryByText("alpha history failed")).toBeNull();
    expect(screen.getByText("333 ms")).toBeInTheDocument();
  });
});
