import { expect, test } from "bun:test";

import { isProseHeavy, LOCAL_ONLY_PROSE_TYPES, PROSE_HEAVY_TYPES } from "../embedding/routing.ts";
import {
  BODY_MAX_DEFAULT,
  BODY_MAX_PROSE,
  bodyCapForItemType,
  clampBody,
  LONG_BODY_TYPES,
} from "./body-caps.ts";

test("prose types get the 16 KiB cap and everything else gets 512", () => {
  expect(bodyCapForItemType("slack", "message")).toBe(BODY_MAX_PROSE);
  expect(bodyCapForItemType("notion", "page")).toBe(BODY_MAX_PROSE);
  expect(bodyCapForItemType("aws", "resource")).toBe(BODY_MAX_DEFAULT);
  expect(bodyCapForItemType("argocd", "application")).toBe(BODY_MAX_DEFAULT);
});

/**
 * The regression #1006's fix could have caused and #1005's fix had to survive.
 *
 * `bodyCapForItemType` used to read `PROSE_HEAVY_TYPES` directly, so removing
 * `nimbus:web_clip` from that set to keep clips off the remote embedder would
 * ALSO have dropped their body cap 16,384 → 512 — silently re-truncating every
 * article. Both halves are asserted together here because neither alone catches
 * it: the routing test would pass, the cap test would pass, and the coupling
 * between them is where the defect lives.
 */
test("web clips keep the 16 KiB cap while staying off the remote embedder", () => {
  expect(bodyCapForItemType("nimbus", "web_clip")).toBe(BODY_MAX_PROSE);
  expect(isProseHeavy("nimbus", "web_clip")).toBe(false);
});

test("LONG_BODY_TYPES is exactly the union of the two source sets", () => {
  const union = new Set([...PROSE_HEAVY_TYPES, ...LOCAL_ONLY_PROSE_TYPES]);
  expect([...LONG_BODY_TYPES].sort()).toEqual([...union].sort());
  for (const key of union) {
    const [service, type] = key.split(":");
    expect(bodyCapForItemType(service as string, type as string)).toBe(BODY_MAX_PROSE);
  }
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
