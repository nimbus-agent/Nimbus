import { describe, expect, test } from "bun:test";

import {
  clampSyncTitle,
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "./pass-cursor-sync-result.ts";

describe("pass-cursor-sync-result", () => {
  test("syncPassCursorHttpEmpty preserves incoming cursor when set", () => {
    const t0 = performance.now();
    const r = syncPassCursorHttpEmpty(t0, 12, "prev", "default");
    expect(r.cursor).toBe("prev");
    expect(r.itemsUpserted).toBe(0);
    expect(r.bytesTransferred).toBe(12);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("syncPassCursorHttpEmpty uses default when incoming is null", () => {
    const t0 = performance.now();
    const r = syncPassCursorHttpEmpty(t0, 0, null, "default");
    expect(r.cursor).toBe("default");
  });

  test("syncPassCursorParseEmpty resets cursor", () => {
    const t0 = performance.now();
    const r = syncPassCursorParseEmpty(t0, 5, "fresh");
    expect(r.cursor).toBe("fresh");
    expect(r.itemsUpserted).toBe(0);
  });

  test("syncPassCursorSuccess carries upsert count", () => {
    const t0 = performance.now();
    const r = syncPassCursorSuccess(t0, 100, "c", 3);
    expect(r.cursor).toBe("c");
    expect(r.itemsUpserted).toBe(3);
  });

  test("clampSyncTitle truncates long strings", () => {
    const s = "x".repeat(600);
    expect(clampSyncTitle(s)).toHaveLength(512);
    expect(clampSyncTitle("short")).toBe("short");
  });
});
