import { describe, expect, test } from "bun:test";

import { EphemeralVault } from "./ephemeral.ts";

describe("EphemeralVault", () => {
  test("a fresh instance is empty", async () => {
    expect(await new EphemeralVault().listKeys()).toEqual([]);
  });

  test("set / get / delete round-trip", async () => {
    const v = new EphemeralVault();
    await v.set("demo.key", "value");
    expect(await v.get("demo.key")).toBe("value");
    await v.delete("demo.key");
    expect(await v.get("demo.key")).toBeNull();
  });

  test("listKeys is sorted and prefix-filtered", async () => {
    const v = new EphemeralVault();
    await v.set("b.one", "1");
    await v.set("a.two", "2");
    await v.set("a.one", "3");
    expect(await v.listKeys()).toEqual(["a.one", "a.two", "b.one"]);
    expect(await v.listKeys("a.")).toEqual(["a.one", "a.two"]);
  });

  test("two instances share nothing — nothing is persisted anywhere", async () => {
    const a = new EphemeralVault();
    await a.set("demo.key", "x");
    expect(await new EphemeralVault().get("demo.key")).toBeNull();
  });

  test("rejects a malformed key exactly like the OS vaults", async () => {
    await expect(new EphemeralVault().set("NOT A KEY", "x")).rejects.toThrow(
      "Invalid vault key format",
    );
  });
});
