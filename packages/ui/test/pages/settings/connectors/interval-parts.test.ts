import { describe, expect, it } from "vitest";
import {
  fromMs,
  MIN_INTERVAL_MS,
  toMs,
} from "../../../../src/pages/settings/connectors/interval-parts";

describe("interval-parts", () => {
  it("MIN_INTERVAL_MS is 60_000", () => {
    expect(MIN_INTERVAL_MS).toBe(60_000);
  });
  it("fromMs(120000) → 2 min", () => {
    expect(fromMs(120_000)).toEqual({ value: 2, unit: "min" });
  });
  it("fromMs(3_600_000) → 1 hr", () => {
    expect(fromMs(3_600_000)).toEqual({ value: 1, unit: "hr" });
  });
  it("fromMs(90_000) → 90 sec (non-minute multiple)", () => {
    expect(fromMs(90_000)).toEqual({ value: 90, unit: "sec" });
  });
  it("toMs round-trips", () => {
    expect(toMs({ value: 3, unit: "min" })).toBe(180_000);
    expect(toMs({ value: 2, unit: "hr" })).toBe(7_200_000);
    expect(toMs({ value: 45, unit: "sec" })).toBe(45_000);
  });

  it("falls back to one minute for a zero or negative interval", () => {
    expect(fromMs(0)).toEqual({ value: 1, unit: "min" });
    expect(fromMs(-5)).toEqual({ value: 1, unit: "min" });
  });
});
