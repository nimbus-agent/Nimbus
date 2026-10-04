import { describe, expect, it } from "vitest";
import { formatAge, orderedSinks } from "../../../src/components/oncall/format";

describe("formatAge", () => {
  const now = 1_790_000_000_000;
  it("buckets", () => {
    expect(formatAge(now - 20_000, now)).toBe("just now");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatAge(now - 2 * 86_400_000, now)).toBe("2 d ago");
  });
  it("a gateway clock ahead of ours reads 'just now', never negative (Review Focus 4)", () => {
    expect(formatAge(now + 90_000, now)).toBe("just now");
  });
});

describe("orderedSinks", () => {
  it("event, toast, chatops first, then the rest alphabetically; absent ones omitted", () => {
    const o = { outcome: "delivered", at: 1 };
    expect(orderedSinks({ zed: o, chatops: o, event: o, alpha: o }).map(([k]) => k)).toEqual([
      "event",
      "chatops",
      "alpha",
      "zed",
    ]);
  });
});
