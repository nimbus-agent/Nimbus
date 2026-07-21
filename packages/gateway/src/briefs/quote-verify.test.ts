import { describe, expect, test } from "bun:test";
import { verifyQuote } from "./quote-verify.ts";

const BODY = "The worker is\nevicted after 30s.  Chrome calls this idle timeout.";

describe("verifyQuote", () => {
  test("matches an exact substring", () => {
    expect(verifyQuote(BODY, "evicted after 30s.")).toBe("evicted after 30s.");
  });

  test("matches across a newline the model rendered as a space", () => {
    expect(verifyQuote(BODY, "The worker is evicted")).toBe("The worker is\nevicted");
  });

  test("matches when the model collapsed a double space", () => {
    expect(verifyQuote(BODY, "30s. Chrome")).toBe("30s.  Chrome");
  });

  test("matches when the model turned a non-breaking space into a normal one", () => {
    expect(verifyQuote(BODY, "this idle timeout")).toBe("this idle timeout");
  });

  test("matches smart quotes against straight quotes in the body", () => {
    expect(verifyQuote('He said "no" loudly', "“no”")).toBe('"no"');
  });

  test("returns the body's characters, not the model's rendition", () => {
    // The model sent a single space; the body has a newline. We must return the body's.
    const got = verifyQuote(BODY, "The worker is evicted");
    expect(got).toContain("\n");
  });

  test("rejects a case change", () => {
    expect(verifyQuote(BODY, "EVICTED AFTER 30S.")).toBeNull();
  });

  test("rejects dropped punctuation", () => {
    expect(verifyQuote(BODY, "evicted after 30s")).not.toBeNull(); // prefix, still present
    expect(verifyQuote(BODY, "The worker is evicted after 30s Chrome")).toBeNull();
  });

  test("rejects a paraphrase", () => {
    expect(verifyQuote(BODY, "the worker gets evicted after half a minute")).toBeNull();
  });

  test("rejects an empty or whitespace-only quote", () => {
    expect(verifyQuote(BODY, "")).toBeNull();
    expect(verifyQuote(BODY, "   ")).toBeNull();
  });

  test("rejects a quote longer than the cap", () => {
    const long = "x".repeat(500);
    expect(verifyQuote(`prefix ${long} suffix`, long)).toBeNull();
  });

  // The normalizer walks UTF-16 code units, so an astral character (emoji, rarer CJK)
  // is two iterations. That keeps the offset map 1:1 per code unit, which is what makes
  // the final body.slice() safe — but web pages are full of emoji, so prove it rather
  // than reason about it.
  test("handles astral-plane characters without splitting a surrogate pair", () => {
    const body = "The build 🚀 shipped on Friday.";
    const got = verifyQuote(body, "build 🚀 shipped");
    expect(got).toBe("build 🚀 shipped");
    expect([...(got ?? "")].length).toBe("build 🚀 shipped".length - 1); // one astral char
  });

  test("handles an emoji adjacent to collapsed whitespace", () => {
    const body = "ship  🚀   now";
    expect(verifyQuote(body, "ship 🚀 now")).toBe("ship  🚀   now");
  });
});
