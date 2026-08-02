import { expect, test } from "bun:test";

import { BODY_MAX_DEFAULT, BODY_MAX_PROSE, bodyCapForItemType, clampBody } from "./body-caps.ts";

test("prose types get the 16 KiB cap and everything else gets 512", () => {
  expect(bodyCapForItemType("slack", "message")).toBe(BODY_MAX_PROSE);
  expect(bodyCapForItemType("notion", "page")).toBe(BODY_MAX_PROSE);
  expect(bodyCapForItemType("aws", "resource")).toBe(BODY_MAX_DEFAULT);
  expect(bodyCapForItemType("argocd", "application")).toBe(BODY_MAX_DEFAULT);
});

test("text at or under the cap is returned unchanged", () => {
  const t = "a".repeat(512);
  expect(clampBody(t, 512)).toBe(t);
  expect(clampBody("", 512)).toBe("");
});

test("text over the cap is cut to the cap", () => {
  expect(clampBody("a".repeat(600), 512)).toHaveLength(512);
});

test("a surrogate pair straddling the cap is not split", () => {
  // "😀" is one code point stored as two UTF-16 code units.
  const straddling = `${"a".repeat(511)}😀`;
  expect(straddling).toHaveLength(513);

  const clamped = clampBody(straddling, 512);

  expect(clamped).toHaveLength(511);
  // A lone surrogate is not representable in UTF-8; round-tripping proves it is absent.
  expect(Buffer.from(clamped, "utf8").toString("utf8")).toBe(clamped);
});

test("a surrogate pair wholly inside the cap is preserved", () => {
  const inside = `${"a".repeat(510)}😀`;
  expect(clampBody(inside, 512)).toBe(inside);
});
