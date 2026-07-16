import { expect, test } from "bun:test";

import { resolveSdkLinkTarget } from "./platform-link.ts";

test("returns sibling nimbus-sdk path when it exists", () => {
  expect(resolveSdkLinkTarget("/c/gitrep/Nimbus", (p) => p === "/c/gitrep/nimbus-sdk")).toBe(
    "/c/gitrep/nimbus-sdk",
  );
});

test("returns null when sibling absent", () => {
  expect(resolveSdkLinkTarget("/c/gitrep/Nimbus", () => false)).toBeNull();
});

test("normalizes windows separators and trailing slashes", () => {
  expect(resolveSdkLinkTarget("C:\\gitrep\\Nimbus\\", (p) => p === "C:/gitrep/nimbus-sdk")).toBe(
    "C:/gitrep/nimbus-sdk",
  );
});
