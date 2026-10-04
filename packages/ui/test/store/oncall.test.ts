import { beforeEach, describe, expect, it } from "vitest";
import { useNimbusStore } from "../../src/store";

describe("oncall slice", () => {
  beforeEach(() => useNimbusStore.setState({ lastSeenPushedAt: 0 }));
  it("starts at 0 and only ever moves forward", () => {
    const { markPushedSeen } = useNimbusStore.getState();
    markPushedSeen(100);
    expect(useNimbusStore.getState().lastSeenPushedAt).toBe(100);
    markPushedSeen(50);
    expect(useNimbusStore.getState().lastSeenPushedAt).toBe(100);
    markPushedSeen(Number.NaN);
    expect(useNimbusStore.getState().lastSeenPushedAt).toBe(100);
  });
  it("survives a rehydrate from storage", async () => {
    localStorage.setItem(
      "nimbus-ui-store",
      JSON.stringify({ state: { lastSeenPushedAt: 42 }, version: 1 }),
    );
    await useNimbusStore.persist.rehydrate();
    expect(useNimbusStore.getState().lastSeenPushedAt).toBe(42);
  });
});
