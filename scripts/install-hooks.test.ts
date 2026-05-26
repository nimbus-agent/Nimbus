import { describe, expect, test } from "bun:test";
import { decideHookInstall } from "./install-hooks.ts";

describe("decideHookInstall", () => {
  test("installs when hooksPath is unset", () => {
    expect(decideHookInstall(null, false)).toEqual({ action: "install" });
  });
  test("no-op when already .githooks", () => {
    expect(decideHookInstall(".githooks", false)).toEqual({ action: "noop" });
  });
  test("warns when set elsewhere without --force", () => {
    expect(decideHookInstall(".husky", false)).toEqual({ action: "warn", current: ".husky" });
  });
  test("installs when set elsewhere with --force", () => {
    expect(decideHookInstall(".husky", true)).toEqual({ action: "install" });
  });
});
