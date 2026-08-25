import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { resolveAccessTokenForService } from "./access-token-registry.ts";

const NO_VAULT = {} as unknown as NimbusVault;

describe("resolveAccessTokenForService", () => {
  test("an unregistered service THROWS rather than yielding an empty token", () => {
    // "" would be sent as a real Authorization header and fail at the far end with an opaque 401,
    // far from the mistake. The throw names the file to edit.
    expect(() => resolveAccessTokenForService(NO_VAULT, "jira")).toThrow(
      /no OAuth access-token resolver is registered for "jira"/,
    );
  });

  test("the error names the registry, so the fix is discoverable from the message alone", () => {
    expect(() => resolveAccessTokenForService(NO_VAULT, "snowflake")).toThrow(
      /sync\/access-token-registry\.ts/,
    );
  });

  test("a registered service reaches its resolver", async () => {
    // Resolution is the property under test, not the OAuth exchange: reaching the helper with an
    // empty vault fails INSIDE it, which still proves the registry dispatched. The helper is
    // async, so this must be awaited — `void` would turn the rejection into an unhandled one and
    // fail the test for a reason unrelated to what it asserts.
    let message = "";
    try {
      await resolveAccessTokenForService(NO_VAULT, "slack");
    } catch (e) {
      message = String(e);
    }
    expect(message).not.toMatch(/no OAuth access-token resolver/);
    expect(message).not.toBe("");
  });
});
