import { describe, expect, test } from "bun:test";
import {
  BLOCK_MS,
  buildReply,
  commonFreeSlots,
  emptyBlocks,
  encodeBlocks,
  MAX_HORIZON_MS,
  MAX_WINDOW_MS,
  markBusy,
  parseReply,
  validateWindow,
} from "./free-busy-blocks.ts";

const NOW = 1_800_000_000_000 - (1_800_000_000_000 % BLOCK_MS); // on a block boundary
const win = (fromBlocks: number, blocks: number) => ({
  fromMs: NOW + fromBlocks * BLOCK_MS,
  toMs: NOW + (fromBlocks + blocks) * BLOCK_MS,
});

describe("validateWindow", () => {
  test("accepts an aligned window inside the limits", () => {
    const w = win(2, 8);
    expect(validateWindow(w.fromMs, w.toMs, NOW)).toEqual(w);
  });
  test("refuses an unaligned end, an empty or reversed window and non-integers", () => {
    expect(validateWindow(NOW, NOW + 1, NOW)).toBeUndefined();
    expect(validateWindow(NOW, NOW, NOW)).toBeUndefined();
    expect(validateWindow(NOW + BLOCK_MS, NOW, NOW)).toBeUndefined();
    expect(validateWindow("a", NOW + BLOCK_MS, NOW)).toBeUndefined();
    expect(validateWindow(NOW + 0.5, NOW + BLOCK_MS, NOW)).toBeUndefined();
    expect(validateWindow(Number.NaN, NOW + BLOCK_MS, NOW)).toBeUndefined();
  });
  test("caps the span at 14 days and the horizon at 21 days", () => {
    expect(validateWindow(NOW, NOW + MAX_WINDOW_MS, NOW)).toBeDefined();
    expect(validateWindow(NOW, NOW + MAX_WINDOW_MS + BLOCK_MS, NOW)).toBeUndefined();
    const far = NOW + MAX_HORIZON_MS - (MAX_HORIZON_MS % BLOCK_MS);
    expect(validateWindow(far - BLOCK_MS, far, NOW)).toBeDefined();
    expect(validateWindow(far, far + BLOCK_MS, NOW)).toBeUndefined();
  });
  test("refuses a window that began more than one block ago", () => {
    expect(validateWindow(NOW - BLOCK_MS, NOW, NOW)).toBeDefined();
    expect(validateWindow(NOW - 2 * BLOCK_MS, NOW, NOW)).toBeUndefined();
  });
});

describe("markBusy and the reply", () => {
  const w = win(0, 6);
  test("an event marks every block it overlaps, edges half-open", () => {
    const b = emptyBlocks(w);
    markBusy(b, w, NOW + BLOCK_MS, NOW + 3 * BLOCK_MS); // blocks 1 and 2
    expect(encodeBlocks(b)).toBe("011000");
  });
  test("a span inside one block marks that block; a zero-length span marks none", () => {
    const b = emptyBlocks(w);
    markBusy(b, w, NOW + 4 * BLOCK_MS + 10, NOW + 4 * BLOCK_MS + 20);
    markBusy(b, w, NOW + 5 * BLOCK_MS, NOW + 5 * BLOCK_MS);
    expect(encodeBlocks(b)).toBe("000010");
  });
  test("a span partly outside the window is clipped to it", () => {
    const b = emptyBlocks(w);
    markBusy(b, w, NOW - 10 * BLOCK_MS, NOW + BLOCK_MS);
    markBusy(b, w, NOW + 5 * BLOCK_MS + 1, NOW + 99 * BLOCK_MS);
    expect(encodeBlocks(b)).toBe("100001");
  });
  test("the reply has exactly three fields", () => {
    const r = buildReply(w, emptyBlocks(w));
    expect(Object.keys(r).sort()).toEqual(["blockMs", "blocks", "fromMs"]);
    expect(r.blocks).toBe("000000");
  });
});

describe("parseReply is strict", () => {
  const w = win(0, 4);
  const good = { fromMs: w.fromMs, blockMs: BLOCK_MS, blocks: "0110" };
  test("reads a well-formed reply", () => {
    expect([...(parseReply(good, w) ?? [])]).toEqual([0, 1, 1, 0]);
  });
  test.each([
    ["wrong length", { ...good, blocks: "011" }],
    ["bad characters", { ...good, blocks: "01x0" }],
    ["another start", { ...good, fromMs: w.fromMs + BLOCK_MS }],
    ["another block length", { ...good, blockMs: 60_000 }],
    ["not an object", "0110"],
    ["null", null],
  ])("refuses %s", (_n, raw) => expect(parseReply(raw, w)).toBeUndefined());
  test("extra fields are dropped, not carried", () => {
    expect(parseReply({ ...good, title: "x" }, w)).toBeDefined();
  });
});

describe("commonFreeSlots", () => {
  const w = win(0, 8);
  const set = (s: string) => Uint8Array.from(s, (c) => (c === "1" ? 1 : 0));
  test("returns the maximal runs free on both sides that fit the duration", () => {
    // mine busy at 2, theirs busy at 5: free runs 0-1, 3-4, 6-7
    const slots = commonFreeSlots(w, set("00100000"), set("00000100"), BLOCK_MS * 2);
    expect(slots).toEqual([
      { startMs: w.fromMs, endMs: w.fromMs + 2 * BLOCK_MS },
      { startMs: w.fromMs + 3 * BLOCK_MS, endMs: w.fromMs + 5 * BLOCK_MS },
      { startMs: w.fromMs + 6 * BLOCK_MS, endMs: w.fromMs + 8 * BLOCK_MS },
    ]);
  });
  test("drops runs shorter than the duration and reports none when there is no room", () => {
    expect(commonFreeSlots(w, set("01010101"), set("00000000"), BLOCK_MS * 2)).toEqual([]);
    expect(commonFreeSlots(w, set("11111111"), set("00000000"), BLOCK_MS)).toEqual([]);
  });
});
