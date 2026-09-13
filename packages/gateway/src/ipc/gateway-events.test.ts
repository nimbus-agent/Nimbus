// packages/gateway/src/ipc/gateway-events.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  emitConnectorHealthChanged,
  emitGatewayEvent,
  setGatewayEventBroadcast,
} from "./gateway-events.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

describe("gateway event sink", () => {
  test("drops emits when nothing is bound, rather than throwing", () => {
    // `buildIdentityBoot`'s precedent: assemble runs BEFORE the IPC broadcast exists, so an
    // unbound emit must be harmless. A unit test that never binds is the common case.
    expect(() =>
      emitGatewayEvent("sync.completed", {
        serviceId: "github",
        itemsUpserted: 1,
        itemsDeleted: 0,
        durationMs: 5,
        hasMore: false,
      }),
    ).not.toThrow();
  });

  test("a bound broadcast receives the envelope with kind, ts and payload", () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    setGatewayEventBroadcast((method, params) => seen.push({ method, params }));
    emitGatewayEvent("watcher.fired", {
      watcherId: "w1",
      name: "P0",
      summary: "fired",
      firedAt: 7,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("gateway.event");
    const p = seen[0]?.params as { kind: string; ts: number; payload: { watcherId: string } };
    expect(p.kind).toBe("watcher.fired");
    expect(typeof p.ts).toBe("number");
    expect(p.payload.watcherId).toBe("w1");
  });

  test("connector health goes out as its OWN named method, not the envelope", () => {
    // The Tauri bridge matches on the METHOD name (`classify_notification`), so this one cannot
    // ride `gateway.event` — that is the whole reason it is named.
    const seen: string[] = [];
    setGatewayEventBroadcast((method) => seen.push(method));
    emitConnectorHealthChanged({
      name: "github",
      health: "error",
      fromState: "degraded",
      reason: "boom",
      occurredAt: 1,
    });
    expect(seen).toEqual(["connector.healthChanged"]);
  });

  test("a throwing subscriber is swallowed", () => {
    // The emit sites are inside health transitions, sync completion and consent prompts. A broken
    // subscriber must never fail the thing it is observing.
    setGatewayEventBroadcast(() => {
      throw new Error("subscriber exploded");
    });
    expect(() =>
      emitGatewayEvent("extension.stateChanged", {
        extensionId: "x",
        action: "enable",
        ok: true,
      }),
    ).not.toThrow();
  });

  test("setGatewayEventBroadcast(undefined) clears a previously bound sink", () => {
    // Without this, one test's sink leaks into the next through module state.
    const seen: string[] = [];
    setGatewayEventBroadcast((m) => seen.push(m));
    setGatewayEventBroadcast(undefined);
    emitGatewayEvent("sync.completed", {
      serviceId: "s",
      itemsUpserted: 0,
      itemsDeleted: 0,
      durationMs: 1,
      hasMore: false,
    });
    expect(seen).toEqual([]);
  });
});
