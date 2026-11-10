import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ipc/client");
vi.mock("../../src/store", () => ({
  useNimbusStore: (selector: (s: { connectionState: string }) => unknown) =>
    selector({ connectionState: "connected" }),
}));

import { useIpcQuery } from "../../src/hooks/useIpcQuery";
import { callMock } from "../../src/ipc/__mocks__/client";

describe("useIpcQuery", () => {
  beforeEach(() => {
    callMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls the method once on mount", async () => {
    callMock.mockResolvedValue({ ok: 1 });
    const { result } = renderHook(() => useIpcQuery<{ ok: number }>("x", 30_000));
    await waitFor(() => expect(result.current.data).toEqual({ ok: 1 }));
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledWith("x", {});
  });

  it("re-calls at interval", async () => {
    callMock.mockResolvedValue("y");
    renderHook(() => useIpcQuery<string>("m", 1_000));
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(1));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(2));
  });

  it("pauses while tab hidden", async () => {
    callMock.mockResolvedValue("y");
    renderHook(() => useIpcQuery<string>("m", 1_000));
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, "visibilityState", { value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(callMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(2));
  });

  it("exposes error on rejection", async () => {
    callMock.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useIpcQuery<string>("m", 30_000));
    await waitFor(() => expect(result.current.error).toBe("boom"));
  });

  it("refetchOnFocus: a window focus event re-runs the query", async () => {
    callMock.mockResolvedValue("v");
    renderHook(() => useIpcQuery<string>("m", 30_000, undefined, { refetchOnFocus: true }));
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(1));
    callMock.mockClear();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(1));
  });

  it("without refetchOnFocus, focus does not re-run", async () => {
    callMock.mockResolvedValue("v");
    renderHook(() => useIpcQuery<string>("m", 30_000));
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(1));
    callMock.mockClear();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(callMock).not.toHaveBeenCalled();
  });

  it("the focus listener is removed on unmount", async () => {
    callMock.mockResolvedValue("v");
    const spy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() =>
      useIpcQuery<string>("m", 30_000, undefined, { refetchOnFocus: true }),
    );
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(1));
    unmount();
    expect(spy).toHaveBeenCalledWith("focus", expect.any(Function));
    spy.mockRestore();
  });

  it("refetch() fires an immediate call", async () => {
    callMock.mockResolvedValue("v");
    const { result } = renderHook(() => useIpcQuery<string>("m", 30_000));
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.refetch();
    });
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(2));
  });
});

describe("useIpcQuery: gating and stale replies", () => {
  beforeEach(() => {
    callMock.mockReset();
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
  });

  it("does not call while disabled", async () => {
    callMock.mockResolvedValue("v");
    renderHook(() => useIpcQuery<string>("m", 1_000, undefined, { enabled: false }));
    await Promise.resolve();
    expect(callMock).not.toHaveBeenCalled();
  });

  it("does not call on mount while the tab is hidden", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden" });
    callMock.mockResolvedValue("v");
    renderHook(() => useIpcQuery<string>("m", 1_000));
    await Promise.resolve();
    expect(callMock).not.toHaveBeenCalled();
  });

  it("reports a non-Error rejection as its string form", async () => {
    callMock.mockRejectedValue("plain failure");
    const { result } = renderHook(() => useIpcQuery<string>("m", 30_000));
    await waitFor(() => expect(result.current.error).toBe("plain failure"));
  });

  it("ignores a reply that a newer call has superseded", async () => {
    let resolveFirst: (v: string) => void = () => undefined;
    callMock.mockImplementationOnce(
      () =>
        new Promise<string>((r) => {
          resolveFirst = r;
        }),
    );
    callMock.mockResolvedValueOnce("fresh");
    const { result } = renderHook(() => useIpcQuery<string>("m", 30_000));
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.refetch();
    });
    await waitFor(() => expect(result.current.data).toBe("fresh"));
    await act(async () => {
      resolveFirst("stale");
      await Promise.resolve();
    });
    expect(result.current.data).toBe("fresh");
  });
});
