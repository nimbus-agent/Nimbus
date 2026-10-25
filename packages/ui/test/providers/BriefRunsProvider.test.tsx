import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcNotification } from "../../src/ipc/types";

let handler: ((n: JsonRpcNotification) => void) | undefined;
const call = vi.fn();
const okSubscribe = async (h: (n: JsonRpcNotification) => void): Promise<() => void> => {
  handler = h;
  return () => {
    handler = undefined;
  };
};
const sub: { impl: (h: (n: JsonRpcNotification) => void) => Promise<() => void> } = {
  impl: okSubscribe,
};
vi.mock("../../src/ipc/client", () => ({
  createIpcClient: () => ({
    call: (m: string, p: unknown) => call(m, p),
    subscribe: (h: (n: JsonRpcNotification) => void) => sub.impl(h),
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
  method: "decisions.briefReady",
  params: { sessionId, brief: "# md" },
});

describe("BriefRunsProvider", () => {
  beforeEach(() => {
    call.mockReset();
    handler = undefined;
    api = undefined;
    sub.impl = okSubscribe;
  });

  it("start does not call the gateway until the subscription has resolved", async () => {
    let release: (() => void) | undefined;
    sub.impl = (h) =>
      new Promise((resolve) => {
        release = () => {
          handler = h;
          resolve(() => undefined);
        };
      });
    call.mockResolvedValue({ sessionId: "s1" });
    mount();
    await vi.waitFor(() => expect(release).toBeDefined());
    let started: Promise<void> | undefined;
    act(() => {
      started = api?.start("decisions", {});
    });
    await Promise.resolve();
    expect(call).not.toHaveBeenCalled();
    await act(async () => {
      release?.();
      await started;
    });
    expect(call).toHaveBeenCalledWith("agents.decisions", {});
  });

  it("a rejected subscribe makes start reject without calling the gateway", async () => {
    sub.impl = () => Promise.reject(new Error("no bridge"));
    mount();
    await act(async () => {
      await expect(api?.start("decisions", {})).rejects.toThrow("no bridge");
    });
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByTestId("s").textContent).toBe("none");
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
