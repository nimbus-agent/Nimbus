import { afterAll, describe, expect, mock, test } from "bun:test";
import { platform as realPlatform } from "node:os";

const savedPlatform = realPlatform;

mock.module("node:os", () => ({
  platform: () => "freebsd",
}));

afterAll(() => {
  mock.module("node:os", () => ({
    platform: savedPlatform,
  }));
});

const { createPlatformServices, PlatformInitError } = await import("./index.ts");

describe("createPlatformServices — error branches (index.ts)", () => {
  test("PlatformInitError is exported from index.ts", () => {
    expect(PlatformInitError).toBeDefined();
    expect(typeof PlatformInitError).toBe("function");
  });

  test("createPlatformServices is a function", () => {
    expect(typeof createPlatformServices).toBe("function");
  });

  test("default branch throws PlatformInitError for unsupported platform", async () => {
    await expect(createPlatformServices()).rejects.toBeInstanceOf(PlatformInitError);
  });

  test("PlatformInitError carries the right name and message", () => {
    const err = new PlatformInitError("Unsupported platform: freebsd");
    expect(err.name).toBe("PlatformInitError");
    expect(err.message).toContain("Unsupported platform");
    expect(err).toBeInstanceOf(PlatformInitError);
    expect(err).toBeInstanceOf(Error);
  });
});
