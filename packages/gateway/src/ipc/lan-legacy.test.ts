import { describe, expect, test } from "bun:test";
import { legacyAllowedFor } from "./lan-legacy.ts";

describe("legacyAllowedFor - the one downgrade check (invariant I56)", () => {
  test("min_protocol 1 allows an unknown peer and a peer recorded at 1", () => {
    expect(legacyAllowedFor(undefined, 1)).toBe(true);
    expect(legacyAllowedFor(1, 1)).toBe(true);
  });

  test("a peer recorded at 2 is never allowed the old wire, whatever min_protocol says", () => {
    expect(legacyAllowedFor(2, 1)).toBe(false);
    expect(legacyAllowedFor(2, 2)).toBe(false);
  });

  test("min_protocol 2 refuses the old wire for everyone", () => {
    expect(legacyAllowedFor(undefined, 2)).toBe(false);
    expect(legacyAllowedFor(1, 2)).toBe(false);
  });
});
