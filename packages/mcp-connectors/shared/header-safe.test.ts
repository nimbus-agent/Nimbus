import { describe, expect, test } from "bun:test";

import { headerLine } from "./header-safe.ts";

describe("headerLine", () => {
  test("accepts a normal header value", () => {
    expect(headerLine().safeParse("user@example.com").success).toBe(true);
    expect(headerLine().safeParse("a@b.com, c@d.com").success).toBe(true);
    expect(headerLine().safeParse("Quarterly report").success).toBe(true);
  });

  test("rejects a CR/LF header-injection payload", () => {
    expect(headerLine().safeParse("user@example.com\r\nBcc: attacker@evil.com").success).toBe(
      false,
    );
    expect(headerLine().safeParse("subject\nX-Injected: 1").success).toBe(false);
    expect(headerLine().safeParse("subject\rfolded").success).toBe(false);
  });

  test("enforces optional min/max bounds", () => {
    expect(headerLine({ min: 1 }).safeParse("").success).toBe(false);
    expect(headerLine({ max: 5 }).safeParse("123456").success).toBe(false);
    expect(headerLine({ min: 1, max: 5 }).safeParse("abc").success).toBe(true);
  });

  test("a CR/LF value fails even when within the length bound", () => {
    expect(headerLine({ min: 1, max: 998 }).safeParse("ok\r\nevil").success).toBe(false);
  });
});
