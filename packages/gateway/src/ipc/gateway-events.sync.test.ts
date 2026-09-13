import { afterEach, describe, expect, test } from "bun:test";
import type { SyncCompletedPayload } from "./gateway-events.ts";
import { emitGatewayEvent, setGatewayEventBroadcast } from "./gateway-events.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

describe("sync.completed", () => {
  test("carries the item deltas the roadmap row promised", () => {
    const seen: Array<Record<string, unknown>> = [];
    setGatewayEventBroadcast((_m, params) => seen.push(params));
    const payload: SyncCompletedPayload = {
      serviceId: "slack",
      itemsUpserted: 14,
      itemsDeleted: 0,
      durationMs: 182,
      bytesTransferred: 4096,
      hasMore: false,
    };
    emitGatewayEvent("sync.completed", { ...payload });
    const p = seen[0] as { kind: string; payload: SyncCompletedPayload };
    expect(p.kind).toBe("sync.completed");
    expect(p.payload.itemsUpserted).toBe(14);
    expect(p.payload.itemsDeleted).toBe(0);
    expect(p.payload.durationMs).toBe(182);
  });

  test("bytesTransferred is optional and omitted rather than zeroed", () => {
    // `SyncResult.bytesTransferred` is optional; a connector that does not report bytes must not
    // be rendered as having transferred none.
    const seen: Array<Record<string, unknown>> = [];
    setGatewayEventBroadcast((_m, params) => seen.push(params));
    emitGatewayEvent("sync.completed", {
      serviceId: "slack",
      itemsUpserted: 1,
      itemsDeleted: 0,
      durationMs: 5,
      hasMore: false,
    });
    const p = seen[0] as { payload: Record<string, unknown> };
    expect("bytesTransferred" in p.payload).toBe(false);
  });
});
