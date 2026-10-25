import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcNotification } from "../../src/ipc/types";

let handler: ((n: JsonRpcNotification) => void) | undefined;
const call = vi.fn();
vi.mock("../../src/ipc/client", () => ({
  createIpcClient: () => ({
    call: (m: string, p: unknown) => call(m, p),
    subscribe: async (h: (n: JsonRpcNotification) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
  }),
}));

import { useBriefRuns } from "../../src/hooks/useBriefRuns";
import { BriefRunsProvider } from "../../src/providers/BriefRunsProvider";

let api: ReturnType<typeof useBriefRuns> | undefined;
function Probe() {
  api = useBriefRuns();
  const r = api.latest("decisions");
  return <span data-testid="s">{r === undefined ? "none" : r.status}</span>;
}
function mount() {
  render(
    <BriefRunsProvider>
      <Probe />
    </BriefRunsProvider>,
  );
}
const ready = (sessionId: string): JsonRpcNotification => ({
  jsonrpc: "2.0",
  method: "decisions.briefReady",
  params: { sessionId, brief: "# md" },
});

describe("BriefRunsProvider", () => {
  beforeEach(() => {
    call.mockReset();
    handler = undefined;
    api = undefined;
  });

  it("subscribes before the first start, and start calls agents.<agent> with the params", async () => {
    call.mockResolvedValue({ sessionId: "s1" });
    mount();
    await vi.waitFor(() => expect(handler).toBeDefined());
    await act(async () => {
      await api?.start("decisions", { q: 1 });
    });
    expect(call).toHaveBeenCalledWith("agents.decisions", { q: 1 });
    expect(screen.getByTestId("s").textContent).toBe("pending");
  });

  it("a briefReady emitted inside the call, before it resolves, is not lost", async () => {
    call.mockImplementation(async () => {
      handler?.(ready("s1"));
      return { sessionId: "s1" };
    });
    mount();
    await vi.waitFor(() => expect(handler).toBeDefined());
    await act(async () => {
      await api?.start("decisions", {});
    });
    expect(screen.getByTestId("s").textContent).toBe("ready");
  });

  it("a later briefReady completes a pending run", async () => {
    call.mockResolvedValue({ sessionId: "s1" });
    mount();
    await vi.waitFor(() => expect(handler).toBeDefined());
    await act(async () => {
      await api?.start("decisions", {});
    });
    act(() => handler?.(ready("s1")));
    expect(screen.getByTestId("s").textContent).toBe("ready");
  });

  it("a rejecting call rejects start and registers nothing", async () => {
    call.mockRejectedValue(new Error("nope"));
    mount();
    await vi.waitFor(() => expect(handler).toBeDefined());
    await act(async () => {
      await expect(api?.start("decisions", {})).rejects.toThrow("nope");
    });
    expect(screen.getByTestId("s").textContent).toBe("none");
  });
});
