import { describe, expect, test } from "bun:test";

import {
  type CostRates,
  costRatesFingerprint,
  pricedFields,
  rateForKey,
  rateKeyFor,
  ratePrice,
} from "./cost-rate-price.ts";

describe("rate prices", () => {
  const rates: CostRates = {
    ratePerMinute: 0.01,
    currency: "USD",
    keyedRates: [
      ["runner:big", 0.05],
      ["size:4x", 0.04],
      ["agent:linux-1", 0.03],
      ["label:gpu", 0.09],
    ],
  };

  test("a key prices at its own rate for each prefix, and falls back to the default when unlisted", () => {
    expect(rateForKey(rates, "runner:big")).toBe(0.05);
    expect(rateForKey(rates, "size:4x")).toBe(0.04);
    expect(rateForKey(rates, "agent:linux-1")).toBe(0.03);
    expect(rateForKey(rates, "label:gpu")).toBe(0.09);
    expect(rateForKey(rates, "runner:small")).toBe(0.01);
    expect(rateForKey(rates, "size:2x")).toBe(0.01);
    expect(rateForKey(rates, "default")).toBe(0.01);
    expect(rateForKey({ ...rates, ratePerMinute: null }, "runner:gone")).toBeNull();
    expect(rateForKey({ ...rates, ratePerMinute: null }, "size:4x")).toBe(0.04);
  });

  test("a key keeps its identity even with no rate listed for it, and a null identity is default", () => {
    expect(rateKeyFor("runner", "big")).toBe("runner:big");
    expect(rateKeyFor("runner", "small")).toBe("runner:small");
    expect(rateKeyFor("size", "4x")).toBe("size:4x");
    expect(rateKeyFor("agent", "built-in")).toBe("agent:built-in");
    expect(rateKeyFor("label", "gpu")).toBe("label:gpu");
    expect(rateKeyFor("runner", null)).toBe("default");
    expect(rateKeyFor("size", null)).toBe("default");
  });

  test("a prefix is part of the key: a size rate never prices a runner of the same name", () => {
    expect(rateForKey(rates, "runner:4x")).toBe(0.01);
  });

  test("rounding is stable, and no rate is an unpriced line", () => {
    expect(ratePrice(3, 0.1)).toBe(0.3);
    expect(pricedFields(100, 0.01)).toEqual({ billedCost: 1, effectiveCost: 1, priced: true });
    expect(pricedFields(100, null)).toEqual({ billedCost: 0, effectiveCost: null, priced: false });
  });

  test("the fingerprint changes with a rate, a key or the currency, and not otherwise", () => {
    const f = costRatesFingerprint(rates);
    expect(costRatesFingerprint({ ...rates })).toBe(f);
    expect(costRatesFingerprint({ ...rates, currency: "EUR" })).not.toBe(f);
    expect(costRatesFingerprint({ ...rates, ratePerMinute: 0.02 })).not.toBe(f);
    expect(costRatesFingerprint({ ...rates, keyedRates: [] })).not.toBe(f);
  });
});
