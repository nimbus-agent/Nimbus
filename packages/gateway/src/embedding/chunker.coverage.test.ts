/**
 * `chunkText` paths `chunker.test.ts` leaves unexercised: the regex sentence split used when the
 * runtime has no working `Intl.Segmenter` (it throws, or yields nothing but whitespace), and the
 * overlap merge leaving a chunk untouched when it already begins with the previous chunk's tail.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chunkText } from "./chunker.ts";

const realSegmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter");

afterEach(() => {
  if (realSegmenter !== undefined) Object.defineProperty(Intl, "Segmenter", realSegmenter);
});

/** Replaces `Intl.Segmenter` for one test; counts how often the replacement is constructed. */
function replaceSegmenter(impl: () => Iterable<{ segment: string }>): {
  constructed: () => number;
} {
  let constructed = 0;
  class FakeSegmenter {
    constructor() {
      constructed += 1;
    }
    segment(): Iterable<{ segment: string }> {
      return impl();
    }
  }
  Object.defineProperty(Intl, "Segmenter", {
    value: FakeSegmenter,
    writable: true,
    configurable: true,
  });
  return { constructed: () => constructed };
}

// Each sentence is its own chunk at this budget (and the 64-char floor keeps every sentence whole).
const ONE_SENTENCE_PER_CHUNK = { maxChunkTokens: 2, overlapTokens: 0 };

describe("chunkText — without a working Intl.Segmenter", () => {
  test("control: the real segmenter splits these sentences", () => {
    expect(chunkText("Ship it. Did it break? Roll back!", ONE_SENTENCE_PER_CHUNK)).toEqual([
      "Ship it.",
      "Did it break?",
      "Roll back!",
    ]);
  });

  test("a Segmenter that throws falls back to splitting after . ! and ?", () => {
    const fake = replaceSegmenter(() => {
      throw new Error("Intl.Segmenter is not supported");
    });
    expect(chunkText("Ship it. Did it break? Roll back!", ONE_SENTENCE_PER_CHUNK)).toEqual([
      "Ship it.",
      "Did it break?",
      "Roll back!",
    ]);
    expect(fake.constructed()).toBe(1);
  });

  test("a Segmenter that yields only whitespace falls back to the same punctuation split", () => {
    const fake = replaceSegmenter(() => [{ segment: "   " }, { segment: "\t\n" }]);
    // The fallback keeps the punctuation with its sentence and splits only where whitespace
    // follows it — "v1.2" is not a sentence boundary.
    expect(
      chunkText("Bumped to v1.2 today. Tests pass!  Merging.", ONE_SENTENCE_PER_CHUNK),
    ).toEqual(["Bumped to v1.2 today.", "Tests pass!", "Merging."]);
    expect(fake.constructed()).toBe(1);
  });
});

describe("chunkText — overlap merge", () => {
  test("a chunk that already begins with the previous chunk's tail is not prefixed again", () => {
    // Each sentence packs alone (3 tokens), and the whole previous chunk (11 chars) fits inside
    // the 32-char overlap window, so the overlap prefix IS the previous chunk — which the next
    // chunk already starts with.
    expect(chunkText("Alpha beta. Alpha beta.", { maxChunkTokens: 3, overlapTokens: 8 })).toEqual([
      "Alpha beta.",
      "Alpha beta.",
    ]);
  });

  test("control: a chunk that does not begin with the tail gets it prepended", () => {
    expect(chunkText("Alpha beta. Gamma delta.", { maxChunkTokens: 3, overlapTokens: 8 })).toEqual([
      "Alpha beta.",
      "Alpha beta. Gamma delta.",
    ]);
  });
});
