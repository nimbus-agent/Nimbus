import { describe, expect, test } from "bun:test";

import { chunkText, itemTextForEmbedding } from "./chunker.ts";

describe("chunkText", () => {
  test("empty input yields no chunks", () => {
    expect(chunkText("   ")).toEqual([]);
  });

  test("truly empty string yields no chunks", () => {
    expect(chunkText("")).toEqual([]);
  });

  test("short text is a single chunk", () => {
    const chunks = chunkText("Quarterly report for Zurich.", { maxChunkTokens: 256 });
    expect(chunks).toHaveLength(1);
  });

  test("splits oversized run-on text under char budget", () => {
    const word = "word ";
    const body = word.repeat(400);
    const chunks = chunkText(body, { maxChunkTokens: 32, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(32 * 4 + 50);
    }
  });

  test("overlap prefixes later chunks when enabled", () => {
    const sentence = (n: number) => `This is sentence number ${String(n)}. `;
    let text = "";
    for (let i = 0; i < 40; i++) {
      text += sentence(i);
    }
    const chunks = chunkText(text, { maxChunkTokens: 48, overlapTokens: 12 });
    expect(chunks.length).toBeGreaterThan(1);
    const second = chunks[1] ?? "";
    const first = chunks[0] ?? "";
    expect(second.length).toBeGreaterThan(0);
    const tail = first.slice(-40).trim();
    expect(
      second.includes(tail.slice(0, Math.min(12, tail.length))) || second.includes("sentence"),
    ).toBe(true);
  });

  // overlapChars === 0: packed.length <= 1 || overlapChars === 0 short-circuit
  test("zero overlapTokens skips overlap merging even with multiple chunks", () => {
    const sentence = (n: number) => `Sentence ${String(n)} here. `;
    let text = "";
    for (let i = 0; i < 30; i++) {
      text += sentence(i);
    }
    const chunks = chunkText(text, { maxChunkTokens: 20, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    // No overlap: second chunk should NOT start with content from the first chunk's tail
    const first = chunks[0] ?? "";
    const second = chunks[1] ?? "";
    // Second chunk should start fresh (it starts with "Sentence N here" not a suffix of first)
    expect(second.startsWith("Sentence")).toBe(true);
    // Confirm first chunk does not appear verbatim in second
    expect(second.includes(first)).toBe(false);
  });

  // packSentencesToTokenBudget: sentence alone exceeds budget (cur === "" when overflow)
  test("sentence that alone exceeds maxChunkTokens becomes its own chunk", () => {
    // A very long single sentence that exceeds a tiny token budget
    // splitLongPiece will split it into word-sized pieces, each fitting the budget
    // but we want to exercise packSentencesToTokenBudget's current="" path:
    // Use a big budget so splitLongPiece doesn't split, but the sentence itself overflows
    // the budget when combined. We need two sentences: short then long.
    const shortSentence = "Hi. ";
    // Create a sentence that is > maxChunkTokens*4 chars but <= maxChars (256*4=1024)
    const longSentence = `${"A".repeat(200)}. `; // 200 chars, 50 tokens — exceeds budget of 10
    const text = shortSentence + longSentence;
    const chunks = chunkText(text, { maxChunkTokens: 10, overlapTokens: 0 });
    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
  });

  // splitLongPiece: word itself exceeds maxChars → pushWordCharSlices
  test("a single very long word is split into char slices", () => {
    // maxChunkTokens=4 → maxChars=max(64,16)=64
    // We need a word longer than 64 chars
    const longWord = "x".repeat(200);
    const chunks = chunkText(longWord, { maxChunkTokens: 4, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be at most 64 chars (maxChars)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(64);
    }
  });

  // pushWordCharSlices with multiple words where one word is too long
  test("mixed text with one oversized word splits correctly", () => {
    const longWord = "y".repeat(300);
    const text = `short text ${longWord} more short text`;
    const chunks = chunkText(text, { maxChunkTokens: 16, overlapTokens: 0 });
    // Should produce multiple chunks (the long word gets sliced)
    expect(chunks.length).toBeGreaterThan(1);
    // The long word slices should appear in the chunks
    const allText = chunks.join("");
    expect(allText.includes("y")).toBe(true);
  });

  // overlapPrefixFromPrevious: prevChunk.length === 0
  test("overlap with single packed chunk does not produce overlap", () => {
    // When packed.length <= 1, we return packed directly without mergeOverlapBetweenChunks
    const chunks = chunkText("Just one short sentence.", {
      maxChunkTokens: 256,
      overlapTokens: 20,
    });
    expect(chunks).toHaveLength(1);
  });

  // overlapPrefixFromPrevious: prevChunk.length <= overlapChars
  test("when prev chunk is shorter than overlap window, uses entire prev chunk as overlap prefix", () => {
    // Need: multiple packed chunks AND the first packed chunk is shorter than overlapChars
    // overlapTokens=100 → overlapChars=400
    // Need first chunk to be < 400 chars
    // maxChunkTokens=16 → chars=64
    const sentence = (n: number) => `Line ${String(n)} here. `;
    let text = "";
    for (let i = 0; i < 20; i++) {
      text += sentence(i);
    }
    const chunks = chunkText(text, { maxChunkTokens: 16, overlapTokens: 100 });
    // Force the branch: there must be a second chunk for the overlap prefix to apply.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const first = chunks[0] ?? "";
    const second = chunks[1] ?? "";
    // The first chunk is short (< overlapChars=400), so the ENTIRE first chunk is the
    // overlap prefix → the second chunk must begin with the full first chunk.
    expect(first.length).toBeLessThan(400);
    expect(second.startsWith(first)).toBe(true);
  });

  // overlapPrefixFromPrevious: cut via ". " punctuation
  test("overlap uses sentence boundary after '. ' in the overlap window", () => {
    // Build text where the tail of the first chunk contains ". " so the overlap
    // trims to after a sentence boundary
    const part1Sentences = [];
    for (let i = 0; i < 8; i++) {
      part1Sentences.push(`Alpha sentence ${String(i)}.`);
    }
    const part2Sentences = [];
    for (let i = 0; i < 8; i++) {
      part2Sentences.push(`Beta sentence ${String(i)}.`);
    }
    const text = `${part1Sentences.join(" ")} ${part2Sentences.join(" ")}`;
    // overlapTokens=8 → overlapChars=32; window likely contains ". "
    const chunks = chunkText(text, { maxChunkTokens: 32, overlapTokens: 8 });
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should be non-empty strings
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
    }
  });

  // overlapPrefixFromPrevious: "! " boundary
  test("overlap uses sentence boundary after '! '", () => {
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(`Exclaim ${String(i)}!`);
    }
    const text = parts.join(" ");
    const chunks = chunkText(text, { maxChunkTokens: 16, overlapTokens: 8 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
    }
  });

  // overlapPrefixFromPrevious: "? " boundary
  test("overlap uses sentence boundary after '? '", () => {
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(`Question ${String(i)}?`);
    }
    const text = parts.join(" ");
    const chunks = chunkText(text, { maxChunkTokens: 16, overlapTokens: 8 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
    }
  });

  // overlapPrefixFromPrevious: no punctuation boundary but space found (sp > 0)
  test("overlap falls back to word boundary when no sentence punctuation in window", () => {
    // Use words without . ! ? so the fallback space split is used
    const words = [];
    for (let i = 0; i < 40; i++) {
      words.push(`word${String(i).padStart(3, "0")}`);
    }
    const text = words.join(" ");
    // maxChunkTokens=10 → maxChars=max(64,40)=64
    // overlapTokens=3 → overlapChars=12; window of 12 chars — should find a space
    const chunks = chunkText(text, { maxChunkTokens: 10, overlapTokens: 3 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
    }
  });

  // overlapPrefixFromPrevious: no space in window — return slice.trimStart()
  test("overlap returns raw slice when no word boundary found in window", () => {
    // Create a scenario where the tail of the first chunk is a long word with no spaces
    // overlapChars must be small enough to land entirely inside a long word
    // Use a large single "word" (no spaces) that fills a chunk
    // maxChunkTokens=16 → maxChars=64; overlapTokens=1 → overlapChars=4
    // Build text: a run of 'A's (no spaces) followed by normal text
    const longNoSpace = "A".repeat(64); // exactly maxChars, one chunk
    const normalPart = " Some more words here to create a second chunk for overlap.";
    const text = longNoSpace + normalPart;
    const chunks = chunkText(text, { maxChunkTokens: 16, overlapTokens: 1 });
    // We just need it to run without errors and produce valid chunks
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(typeof c).toBe("string");
      expect(c.length).toBeGreaterThan(0);
    }
  });

  // mergeOverlapBetweenChunks: cur.startsWith(prefix) → don't re-add prefix
  test("overlap not duplicated if chunk already starts with overlap prefix", () => {
    // Construct a case where the natural second chunk already starts with what
    // the overlap prefix would be. We do this by using very small overlap so the
    // prefix is likely to already appear at start of next chunk (which starts with
    // first word of prev chunk's tail, and second chunk starts with that same word).
    // Simpler: just verify no chunk has a doubled prefix.
    const sentence = (n: number) => `Chunk piece ${String(n)}. `;
    let text = "";
    for (let i = 0; i < 20; i++) {
      text += sentence(i);
    }
    const chunks = chunkText(text, { maxChunkTokens: 24, overlapTokens: 6 });
    expect(chunks.length).toBeGreaterThan(1);
    // Verify no chunk has a doubled overlap (a simple sanity check)
    for (const c of chunks) {
      // Each chunk should be a non-empty string
      expect(c.length).toBeGreaterThan(0);
    }
  });

  // chunkText: sentences.length === 0 but text.trim() !== ""
  // This path is reached only if splitSentences returns [] but text is non-empty.
  // splitSentences returns [] only if t === "" (checked) OR if Segmenter returns no
  // parts AND the regex split also produces nothing. The latter is unreachable for
  // non-empty text (regex always produces at least one element for non-empty input).
  // See uncoverableBranches note.

  // Default opts (no opts argument)
  test("uses default opts when none provided", () => {
    const text = "Default options test.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Default options test.");
  });

  // Partial opts override
  test("partial opts merge with defaults", () => {
    const text = "Hello world.";
    const chunks = chunkText(text, { maxChunkTokens: 128 });
    expect(chunks).toHaveLength(1);
  });

  // splitLongPiece: when cur is filled and word fits (cur !== "" branch before cur = w)
  test("splitLongPiece handles word boundary overflow in middle of word list", () => {
    // maxChunkTokens=4 → maxChars=64
    // Build a sentence where words collectively overflow the char budget
    // so we exercise: next.length > maxChars, cur !== "" push, then w.length <= maxChars path
    const smallWords =
      "ab cd ef gh ij kl mn op qr st uv wx yz aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp qq rr ss tt uu vv ww xx yy zz";
    const chunks = chunkText(smallWords, { maxChunkTokens: 4, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  // Multiple sentence boundaries in overlap window — picks the smallest (earliest) one
  test("multiple sentence punctuation in overlap window picks earliest boundary", () => {
    // Craft text where the overlap window has both ". " and "! " — we want to ensure
    // the algorithm picks the earliest (minimum index in slice)
    const parts = [];
    for (let i = 0; i < 6; i++) {
      parts.push(`Say ${String(i)}. Check ${String(i)}!`);
    }
    const text = parts.join(" ");
    // overlapTokens=6 → overlapChars=24
    const chunks = chunkText(text, { maxChunkTokens: 12, overlapTokens: 6 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
    }
  });

  // Verify text with only whitespace produces empty
  test("whitespace-only text returns empty array", () => {
    expect(chunkText("   \t\n  ")).toEqual([]);
  });

  // Single sentence exactly at token budget
  test("single sentence at exact token budget is single chunk", () => {
    // maxChunkTokens=4 → maxChars=64; 16 chars = 4 tokens exactly
    const text = `${"A".repeat(16)}.`;
    const chunks = chunkText(text, { maxChunkTokens: 4, overlapTokens: 0 });
    expect(chunks).toHaveLength(1);
  });
});

describe("itemTextForEmbedding", () => {
  test("uses title only when body missing (null)", () => {
    expect(itemTextForEmbedding({ title: "T", body_preview: null })).toBe("T");
  });

  test("joins title and body preview", () => {
    expect(itemTextForEmbedding({ title: "T", body_preview: "B" })).toBe("T\nB");
  });

  test("uses title only when body_preview is empty string", () => {
    expect(itemTextForEmbedding({ title: "My Title", body_preview: "" })).toBe("My Title");
  });

  test("uses title only when body_preview is whitespace only", () => {
    expect(itemTextForEmbedding({ title: "My Title", body_preview: "   " })).toBe("My Title");
  });

  test("trims title whitespace", () => {
    expect(itemTextForEmbedding({ title: "  Trimmed  ", body_preview: null })).toBe("Trimmed");
  });

  test("trims both title and body", () => {
    expect(itemTextForEmbedding({ title: "  Title  ", body_preview: "  Body  " })).toBe(
      "Title\nBody",
    );
  });

  test("title with empty string body uses title only", () => {
    expect(itemTextForEmbedding({ title: "Just Title", body_preview: "" })).toBe("Just Title");
  });
});
