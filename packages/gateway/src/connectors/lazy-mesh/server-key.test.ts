import { describe, expect, test } from "bun:test";

import { extensionServerKey as reExported } from "./extension-slot.ts";
import { extensionServerKey } from "./server-key.ts";

describe("extensionServerKey", () => {
  test("keeps letters, digits, _ and -; replaces everything else with _", () => {
    expect(extensionServerKey("ext_acme-x_1")).toBe("ext_acme-x_1");
    expect(extensionServerKey("ext.a/b c")).toBe("ext_a_b_c");
  });

  test("extension-slot.ts re-exports the same function", () => {
    expect(reExported).toBe(extensionServerKey);
  });
});
