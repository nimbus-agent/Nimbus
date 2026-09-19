import { afterAll, describe, expect, mock, test } from "bun:test";
import { platform as realPlatform } from "node:os";
import type { PlatformPaths } from "../platform/paths.ts";

const savedPlatform = realPlatform;

mock.module("node:os", () => ({
  platform: () => "freebsd",
}));

afterAll(() => {
  mock.module("node:os", () => ({
    platform: savedPlatform,
  }));
});

const { createNimbusVault } = await import("./factory.ts");
const { PlatformInitError } = await import("../platform/errors.ts");
const { EphemeralVault } = await import("./ephemeral.ts");

describe("createNimbusVault factory", () => {
  test("createNimbusVault is an async function", () => {
    expect(typeof createNimbusVault).toBe("function");
    const proto = Object.getPrototypeOf(createNimbusVault) as { constructor: { name: string } };
    expect(proto.constructor.name).toBe("AsyncFunction");
  });

  test("default branch throws PlatformInitError for unsupported platform", async () => {
    await expect(createNimbusVault({} as unknown as PlatformPaths)).rejects.toBeInstanceOf(
      PlatformInitError,
    );
  });

  test("PlatformInitError carries the right name and message", () => {
    const err = new PlatformInitError("Unsupported platform for vault: freebsd");
    expect(err.name).toBe("PlatformInitError");
    expect(err.message).toContain("Unsupported platform for vault");
    expect(err).toBeInstanceOf(PlatformInitError);
    expect(err).toBeInstanceOf(Error);
  });

  test("a demo-rooted process gets an EphemeralVault — decided BEFORE the OS switch", async () => {
    // node:os is mocked to "freebsd" above, so a non-demo call throws (previous test). A demo
    // call must still succeed: that proves the demo check precedes the platform switch, i.e. a
    // demo process never reaches ANY OS credential store.
    const v = await createNimbusVault({ demo: true } as unknown as PlatformPaths);
    expect(v).toBeInstanceOf(EphemeralVault);
    expect(await v.listKeys()).toEqual([]);
  });
});
