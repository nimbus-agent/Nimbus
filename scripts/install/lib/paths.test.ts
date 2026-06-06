import { describe, expect, test } from "bun:test";
import { resolveInstallDir } from "./paths.ts";

describe("resolveInstallDir", () => {
  test(String.raw`windows: %LOCALAPPDATA%\Programs\Nimbus\bin`, () => {
    const env = { LOCALAPPDATA: String.raw`C:\Users\jane\AppData\Local` };
    expect(resolveInstallDir("win32", env)).toBe(
      String.raw`C:\Users\jane\AppData\Local\Programs\Nimbus\bin`,
    );
  });

  test("windows: throws if LOCALAPPDATA is unset", () => {
    expect(() => resolveInstallDir("win32", {})).toThrow(/LOCALAPPDATA/);
  });

  test("darwin: ~/.local/bin", () => {
    expect(resolveInstallDir("darwin", { HOME: "/Users/jane" })).toBe("/Users/jane/.local/bin");
  });

  test("linux: ~/.local/bin", () => {
    expect(resolveInstallDir("linux", { HOME: "/home/jane" })).toBe("/home/jane/.local/bin");
  });

  test("darwin/linux: throws if HOME is unset", () => {
    expect(() => resolveInstallDir("darwin", {})).toThrow(/HOME/);
  });

  test("unknown platform throws", () => {
    expect(() => resolveInstallDir("aix" as never, { HOME: "/home/x" })).toThrow(/unsupported/i);
  });
});
