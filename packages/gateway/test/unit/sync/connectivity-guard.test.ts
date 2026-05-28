import { describe, expect, test } from "bun:test";
import { DEFAULT_CONNECTIVITY_PROBE_HOST, isOnline } from "../../../src/sync/connectivity.ts";

describe("isOnline", () => {
  test("returns false when DNS lookup rejects", async () => {
    const original = Bun.dns.lookup;
    // @ts-expect-error -- patching for test
    Bun.dns.lookup = async () => {
      throw new Error("ENOTFOUND");
    };

    const result = await isOnline("unreachable.invalid");
    expect(result).toBe(false);

    // @ts-expect-error -- restore
    Bun.dns.lookup = original;
  });

  test("never throws — all errors map to false", async () => {
    const original = Bun.dns.lookup;
    // @ts-expect-error -- patching for test
    Bun.dns.lookup = async () => {
      throw new TypeError("unexpected error type");
    };

    const result = await isOnline();
    expect(result).toBe(false);

    // @ts-expect-error -- restore
    Bun.dns.lookup = original;
  });

  test("returns true when DNS lookup resolves", async () => {
    const original = Bun.dns.lookup;
    // @ts-expect-error -- patching for test
    Bun.dns.lookup = async () => [{ address: "dns-mock-success", family: 4 }];

    const result = await isOnline();
    expect(result).toBe(true);

    // @ts-expect-error -- restore
    Bun.dns.lookup = original;
  });

  test("DEFAULT_CONNECTIVITY_PROBE_HOST is one.one.one.one", () => {
    expect(DEFAULT_CONNECTIVITY_PROBE_HOST).toBe("one.one.one.one");
  });
});
