import { describe, expect, test } from "bun:test";
import {
  decodeEntitiesOnce,
  foldAndStrip,
  isInvisibleOrControl,
  NORMALISE_MAX_ROUNDS,
  settle,
  settleUrl,
} from "./text-normalise.ts";

const TAB = String.fromCodePoint(0x09);
const LF = String.fromCodePoint(0x0a);
const ZWSP = String.fromCodePoint(0x200b);
const FULLWIDTH_COLON = String.fromCodePoint(0xff1a);
const FULLWIDTH_SOLIDUS = String.fromCodePoint(0xff0f);
const NBSP = String.fromCodePoint(0xa0);
const LINE_SEP = String.fromCodePoint(0x2028);

describe("text-normalise (moved from model-write-refusals in B3r)", () => {
  test("NORMALISE_MAX_ROUNDS is 4", () => {
    expect(NORMALISE_MAX_ROUNDS).toBe(4);
  });

  test("isInvisibleOrControl: C0, the invisible ranges, and nothing else", () => {
    expect(isInvisibleOrControl(0x00)).toBe(true);
    expect(isInvisibleOrControl(0x09)).toBe(true);
    expect(isInvisibleOrControl(0x1f)).toBe(true);
    expect(isInvisibleOrControl(0x200b)).toBe(true);
    expect(isInvisibleOrControl(0xe0041)).toBe(true);
    expect(isInvisibleOrControl(0x20)).toBe(false);
    expect(isInvisibleOrControl(0x61)).toBe(false);
    expect(isInvisibleOrControl(0x202f)).toBe(false);
  });

  test("foldAndStrip: NFKC, then invisible and control characters deleted", () => {
    expect(foldAndStrip(`a${ZWSP}b${TAB}c`)).toBe("abc");
    expect(foldAndStrip(`https${FULLWIDTH_COLON}`)).toBe("https:");
  });

  test("decodeEntitiesOnce: six names, decimal and hex, one pass, unknown kept", () => {
    expect(decodeEntitiesOnce("&lt;&GT;&amp;&quot;&apos;")).toBe(`<>&"'`);
    expect(decodeEntitiesOnce("&nbsp;")).toBe(NBSP);
    expect(decodeEntitiesOnce("&#47;&#x2F;&#47")).toBe("///");
    expect(decodeEntitiesOnce("&amp;lt;")).toBe("&lt;");
    expect(decodeEntitiesOnce("&sol;&colon;")).toBe("&sol;&colon;");
    expect(decodeEntitiesOnce("&#xD800;&#1114112;")).toBe("&#xD800;&#1114112;");
    // A JS-prototype name is not an entity.
    expect(decodeEntitiesOnce("&constructor;")).toBe("&constructor;");
  });

  test("settle: the printable-ASCII fast path stops exactly at `&`, C0 and DEL", () => {
    expect(settle("Plain ASCII, no entity!", "")).toBe("plain ascii, no entity!");
    expect(settle("a&amp;b", "")).toBe("a&b");
    expect(settle(`a${String.fromCodePoint(0x01)}b`, "")).toBe("ab");
    expect(settle(`a${String.fromCodePoint(0x7f)}b`, "")).toBe("ab");
    expect(settle(`a${String.fromCodePoint(0x01)}b`, " ")).toBe("a b");
    expect(settle(`a${TAB}b`, "", true)).toBe("a b");
  });

  test("settle: the B1 loop (collapse, lower-case, keepLines, unsettled)", () => {
    expect(settle(`A${TAB}${TAB}B`, "")).toBe("a b");
    expect(settle(`a${ZWSP}b`, " ")).toBe("a b");
    expect(settle(`a${LINE_SEP}b`, "", true)).toBe(`a${LF}b`);
    expect(settle("&amp;amp;amp;amp;amp;lt;", "")).toBeUndefined();
  });
});

describe("settleUrl (B3r, plan R2)", () => {
  test("entities decode to the protocol-relative form", () => {
    expect(settleUrl("&#x2F;&#x2F;h")).toBe("//h");
    expect(settleUrl("&#47;&#47;h")).toBe("//h");
  });

  test("a TAB inside is deleted, where settle makes it a space", () => {
    expect(settleUrl(`/${TAB}/h`)).toBe("//h");
    expect(settle(`/${TAB}/h`, "")).toBe("/ /h");
  });

  test("trimmed and lower-cased", () => {
    expect(settleUrl(" HTTPS://H ")).toBe("https://h");
  });

  test("an unknown named entity is kept, so R2(c) can see it", () => {
    expect(settleUrl("&sol;")).toBe("&sol;");
  });

  test("NFKC folds and invisible characters are deleted", () => {
    expect(settleUrl(`https${FULLWIDTH_COLON}//h`)).toBe("https://h");
    expect(settleUrl(`/${ZWSP}/h`)).toBe("//h");
    expect(settleUrl(`a${FULLWIDTH_SOLIDUS}b`)).toBe("a/b");
  });

  test("an entity nested five deep does not settle in four rounds", () => {
    expect(settleUrl("&amp;amp;amp;amp;amp;")).toBeUndefined();
    // Three decodes settle: the fourth round sees no change.
    expect(settleUrl("&amp;amp;lt;")).toBe("<");
  });
});
