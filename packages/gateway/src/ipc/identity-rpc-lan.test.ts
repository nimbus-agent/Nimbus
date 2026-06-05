import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("identity/scim methods are forbidden over LAN", () => {
  test("FORBIDDEN_OVER_LAN lists every identity.* and scim.* management method", () => {
    const src = readFileSync("packages/gateway/src/ipc/lan-rpc.ts", "utf8");
    for (const m of [
      "identity.login",
      "identity.status",
      "identity.logout",
      "identity.bind",
      "identity.unbind",
      "identity.listBindings",
      "scim.status",
      "scim.setToken",
      "scim.listUsers",
      "scim.deprovision",
    ]) {
      expect(src).toContain(`"${m}"`);
    }
  });
});
