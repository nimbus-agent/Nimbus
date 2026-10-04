import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcNotification } from "../../src/ipc/types";

const query = {
  data: null as unknown,
  error: null as string | null,
  isLoading: false,
  refetch: vi.fn(),
};
vi.mock("../../src/hooks/useIpcQuery", () => ({ useIpcQuery: () => query }));
let handler: ((n: JsonRpcNotification) => void) | undefined;
vi.mock("../../src/ipc/client", () => ({
  createIpcClient: () => ({
    subscribe: async (h: (n: JsonRpcNotification) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
  }),
}));

import { useOncallBriefs } from "../../src/hooks/useOncallBriefs";
import { OncallBriefsProvider } from "../../src/providers/OncallBriefsProvider";

function Probe() {
  const s = useOncallBriefs();
  return (
    <span data-testid="seq">
      {s.lastPushed === null ? "none" : `${s.lastPushed.incidentId}#${s.lastPushed.seq}`}
    </span>
  );
}
const pushed = (id: string): JsonRpcNotification => ({
  method: "gateway.event",
  params: { kind: "oncall.briefPushed", ts: 1, payload: { incidentId: id, status: "ok" } },
});

function mount() {
  render(
    <OncallBriefsProvider>
      <Probe />
    </OncallBriefsProvider>,
  );
}

describe("OncallBriefsProvider", () => {
  beforeEach(() => {
    query.refetch.mockReset();
    handler = undefined;
  });
  it("one matching event gives exactly one refetch, and lastPushed names it", async () => {
    mount();
    await vi.waitFor(() => expect(handler).toBeDefined());
    act(() => handler?.(pushed("pagerduty:A")));
    expect(query.refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("seq").textContent).toBe("pagerduty:A#1");
  });
  it("two events for the same id give two refetches, and seq advances", async () => {
    mount();
    await vi.waitFor(() => expect(handler).toBeDefined());
    act(() => handler?.(pushed("pagerduty:A")));
    act(() => handler?.(pushed("pagerduty:A")));
    expect(query.refetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("seq").textContent).toBe("pagerduty:A#2");
  });
  it("other notifications cause no refetch", async () => {
    mount();
    await vi.waitFor(() => expect(handler).toBeDefined());
    act(() =>
      handler?.({ method: "gateway.event", params: { kind: "sync.completed", payload: {} } }),
    );
    act(() => handler?.({ method: "connector.healthChanged", params: {} }));
    expect(query.refetch).not.toHaveBeenCalled();
  });
  it("useOncallBriefs outside the provider throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/OncallBriefsProvider/);
    spy.mockRestore();
  });
});
