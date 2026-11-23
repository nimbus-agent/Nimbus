import { describe, expect, test } from "bun:test";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I6 — LAN bind defaults to loopback", () => {
  test("DEFAULT_NIMBUS_LAN_TOML.bind is 127.0.0.1, never 0.0.0.0", async () => {
    const src = await read("packages/gateway/src/config/nimbus-toml/lan.ts");
    expect(src).not.toMatch(/bind:\s*"0\.0\.0\.0"/);
    expect(src).toMatch(/bind:\s*"127\.0\.0\.1"/);
  });
});
