import { expect, test } from "bun:test";

import { stripQuotedTail } from "./email-quoted-text.ts";

test("cuts a trailing > quote block", () => {
  expect(stripQuotedTail("Yes, agreed.\n\n> the original\n> more original")).toBe("Yes, agreed.");
});

test("cuts at an attribution line", () => {
  expect(stripQuotedTail("Sure.\n\nOn Mon, 4 Aug 2026, Ana wrote:\n> hi")).toBe("Sure.");
});

test("cuts at -----Original Message-----", () => {
  expect(stripQuotedTail("Done.\n\n-----Original Message-----\nFrom: x")).toBe("Done.");
});

test("cuts at the Outlook underscore divider", () => {
  expect(stripQuotedTail(`Ack.\n\n${"_".repeat(32)}\nFrom: x\nSent: y`)).toBe("Ack.");
});

test("cuts a trailing Outlook header block with no divider", () => {
  expect(
    stripQuotedTail("Looks good.\n\nFrom: Ana <a@x.com>\nSent: Tuesday\nTo: Bo\nSubject: Re: spec"),
  ).toBe("Looks good.");
});

test("cuts a trailing signature delimiter", () => {
  expect(stripQuotedTail("Thanks!\n\n-- \nAna\nCTO")).toBe("Thanks!");
});

test("handles CRLF line endings", () => {
  expect(stripQuotedTail("Yes.\r\n\r\n> quoted")).toBe("Yes.");
});

test("cuts at an attribution the client wrapped across two lines", () => {
  const body =
    "Agreed.\n\nOn Mon, Aug 3, 2026 at 4:32 PM User\n<user@example.com> wrote:\n> the thread";
  expect(stripQuotedTail(body)).toBe("Agreed.");
});

test("a terminal-marker cut still slices from the ORIGINAL lines", () => {
  // The join+cut test in the unchanged table returns through the early "no
  // marker at all" exit and never reaches the slice, so it doesn't actually
  // guard the analysis-only-join property. This one's cut is driven by the
  // terminal-marker path, which is where a `lines.slice` (joined-text)
  // regression would actually be visible.
  const body =
    "On Mon, Aug 3, 2026 at 4:32 PM User\n<user@example.com> wrote:\n\nMy reply.\n\n-- \nAna";
  expect(stripQuotedTail(body)).toBe(
    "On Mon, Aug 3, 2026 at 4:32 PM User\n<user@example.com> wrote:\n\nMy reply.",
  );
});

test("a terminal marker followed by a further quote tail cuts at the marker, not below it", () => {
  const body = "Thanks.\n\n-- \nAna\n\n> old text\n> more old";
  expect(stripQuotedTail(body)).toBe("Thanks.");
});

test("a quote tail running into a terminal signature marker cuts at the walk's earlier index", () => {
  const body = "Reply.\n\n> old quote\n> more quote\n-- ";
  expect(stripQuotedTail(body)).toBe("Reply.");
});

test("a divider followed by a > quote block IS terminal", () => {
  // The other half of the gate: the divider does introduce a quoted block, so
  // it keeps its terminal status.
  expect(stripQuotedTail(`Ack.\n\n${"_".repeat(32)}\n> the original thread`)).toBe("Ack.");
});

test("a terminal marker appearing twice cuts at the LAST one", () => {
  const body = "A.\n\n-----Original Message-----\nFrom: x\n\n-----Original Message-----\nFrom: y";
  expect(stripQuotedTail(body)).toBe("A.\n\n-----Original Message-----\nFrom: x");
});

test("a signature delimiter WITH the trailing space cuts", () => {
  expect(stripQuotedTail("Thanks.\n\n-- \nAna")).toBe("Thanks.");
});

test("a divider immediately followed by a quote (no prose in between) still cuts, even via the walk path", () => {
  // The walk's own `isMarker` gate (not just the terminal scan) must honour
  // the same adjacency rule: dropping DIVIDER_RE from `isMarker` entirely
  // (CodeRabbit's literal suggested diff) would leave a divider that
  // genuinely precedes a quote sitting in the KEPT text instead of being
  // stripped along with the quote below it.
  expect(stripQuotedTail(`Intro\n${"_".repeat(12)}\n> real quote`)).toBe("Intro");
});

test("a blank line between the divider and the quoted block does not break adjacency", () => {
  // "First nonblank line below" — blank lines in between must not count
  // against qualification.
  expect(stripQuotedTail(`Ack.\n\n${"_".repeat(12)}\n\n> the original thread`)).toBe("Ack.");
});

test("an underscore divider followed by the author's OWN prose, with a real quote further below, keeps the prose", () => {
  // The false positive CodeRabbit flagged: "does ANY line below qualify"
  // (the pre-fix `quotedBlockBelowFlags`) sees the `> quote` two lines down
  // and marks the DIVIDER terminal, deleting "Own prose" along with it even
  // though the line immediately below the divider is the author's own text,
  // not a quote. Qualification must require ADJACENCY — the first nonblank
  // line below — not merely "some line below, anywhere". The trailing
  // `> quote` line is still genuinely quoted content and is correctly
  // stripped by the ordinary backward walk (a `>` line IS an unconditional
  // marker) — it is "Own prose" that must survive, and it does.
  const body = "Intro\n__________\nOwn prose\n> quote";
  expect(stripQuotedTail(body)).toBe("Intro\n__________\nOwn prose");
});

/**
 * Bodies that must come back EXACTLY as they went in.
 *
 * Every row is a different false positive the trimmer has to avoid — a
 * heuristic that deletes content earns its keep by what it REFUSES to cut —
 * but the assertion is identical for all of them, so the case list is data
 * rather than fifteen copies of one test body. The reason each row is
 * interesting is on the row itself.
 */
const UNCHANGED_BODIES: Array<[string, string]> = [
  // An inline quotation is followed by more of the author's own prose, so the
  // quoted block is not a TAIL and cutting at the first marker would destroy
  // exactly the messages worth reading.
  [
    "an inline quote followed by more of the author's prose",
    "Here's my take.\n\n> quoting the spec\n> more spec\n\nActually I disagree because Z.",
  ],
  // A single `From:` inside a pasted log must not look like a quoted header
  // block; a header field counts only when an ADJACENT line is one too.
  ["a lone From: line in a pasted log", "Log follows:\n\nFrom: cache\nstatus=200\ndone"],
  [
    "a header block mid-message with prose below it",
    "See below.\n\nFrom: Ana\nSent: Tue\n\nMy actual point is Z.",
  ],
  ["no marker anywhere", "Just a plain message."],
  // Never return empty: a wholly-quoted body falls back to the untrimmed text.
  ["a wholly-quoted body", "> everything\n> is quoted"],
  // The wrap-join is analysis-only; the returned text is sliced from the
  // original lines, so an attribution in the KEPT region is not reflowed.
  [
    "an attribution sitting in the kept region",
    "On Mon, Aug 3, 2026 at 4:32 PM User\n<user@example.com> wrote:\n\nMy actual reply.",
  ],
  [
    "an attribution opener with no closer within the wrap budget",
    "On the whole\nI think we should\nship it\nand see.",
  ],
  ["empty input", ""],
  ["a body that is ONLY a signature block", "-- \nAna\nCTO"],
  [
    "a body that is ONLY an -----Original Message----- block",
    "-----Original Message-----\nFrom: x",
  ],
  ["three hyphens, which are not a signature delimiter", "Thanks!\n\n---\nnot a delimiter"],
  // A 10+ underscore rule is an ordinary human formatting idiom. Treating it
  // as unconditionally terminal (as `-----Original Message-----` and `-- `
  // genuinely are) silently deleted the whole rest of the message. Its
  // Outlook meaning is "a quoted header block follows"; nothing follows here
  // but the author's own prose, so nothing may be cut.
  [
    "the author's own horizontal rule with prose below it",
    `Intro\n\n${"_".repeat(10)}\n\nSection two body text\nmore text`,
  ],
  ["fewer than 10 underscores, which is not a divider", `Body.\n\n${"_".repeat(9)}\nnot header`],
  // A false positive here would silently delete real prose (e.g. a
  // Setext-style heading underline); prefer the false negative.
  ["a bare -- with no trailing space", "Thanks.\n\n--\nnot a signature, just two dashes."],
  // With nothing below it at all, a divider must not qualify as a marker.
  ["a bare trailing divider with nothing quoted below it", "Real content\nMore of it\n__________"],
];

test.each(UNCHANGED_BODIES)("returns the body unchanged: %s", (_name, body) => {
  expect(stripQuotedTail(body)).toBe(body);
});

test("a pathological attribution-shaped line does not cause catastrophic backtracking", () => {
  // Adversarial shape: two `.+` separated by a literal, with no trailing
  // colon so the match fails only after exhausting the backtracking search
  // space. Unbounded, this scales quadratically with input length (measured
  // 20 KB -> 11.5 ms, 40 KB -> 45.3 ms, 80 KB -> 186.5 ms — a clean 4x per
  // doubling); at this input size (~500 KB) the unbounded regex would take
  // several seconds. The bounded regex (`.{1,400}`) clears this in single-
  // digit milliseconds regardless of input length, so a 1000 ms ceiling
  // leaves multiple orders of magnitude of headroom against CI jitter while
  // still reliably catching a regression back to the unbounded form.
  const pathological = `am ${"schrieb x ".repeat(50_000)}`;
  const body = `Intro.\n\n${pathological}`;
  const startedAt = performance.now();
  const result = stripQuotedTail(body);
  const elapsedMs = performance.now() - startedAt;
  expect(result).toBe(body);
  expect(elapsedMs).toBeLessThan(1000);
});

test("many non-terminal dividers do not cost quadratic time", () => {
  // The conditional gate on DIVIDER_RE (an underscore rule is terminal only
  // when a quoted block actually follows) must not be evaluated by scanning
  // downward from each divider: the terminal loop tries EVERY divider and
  // only breaks when one qualifies, so a body whose dividers all fail the
  // gate — exactly the false-positive case the gate exists to allow — costs
  // Σ(n−i). Measured against the real `stripQuotedTail` with a per-divider
  // downward scan: 27 KB -> 50 ms, 55 KB -> 198 ms, 110 KB -> 770 ms,
  // 220 KB -> 3811 ms, 440 KB -> 20093 ms, a clean 4x per doubling; the
  // degenerate all-underscore shape is not required either (1.2 MB of
  // alternating divider/prose measured 10555 ms). The O(n) suffix pass
  // (`quotedBlockBelowFlags`) clears this same input in ~4 ms, so a 1000 ms
  // ceiling leaves two orders of magnitude of headroom against CI jitter
  // while still reliably catching a regression back to the per-divider scan.
  //
  // Email bodies are remote-attacker-controlled and `stripQuotedTail` runs
  // synchronously on the gateway event loop from `gmail/api.ts` and
  // `outlook-sync.ts` BEFORE any body cap applies — nothing upstream bounds
  // this input.
  const body = `Intro\n${`${"_".repeat(10)}\n`.repeat(20_000)}tail prose`;
  const startedAt = performance.now();
  const result = stripQuotedTail(body);
  const elapsedMs = performance.now() - startedAt;
  // No divider introduces a quoted block, so nothing may be cut — the same
  // property the false-positive row above asserts, at scale.
  expect(result).toBe(body);
  expect(elapsedMs).toBeLessThan(1000);
});

// ---------------------------------------------------------------------------
// Growth-shape regression: the trailing-whitespace trim.
//
// The kept region used to be trimmed with `.replace(/\s+$/, "")`. `\s+$` has
// no start anchor, so a backtracking engine restarts the greedy `\s+` at EVERY
// position of a whitespace run and re-fails the `$` check after each one —
// Σ(n−i) work, quadratic in the run length. Measured on Bun 1.3, `/\s+$/`
// through `.test()` is exactly that (4 KB 5.6 ms, 8 KB 24 ms, 16 KB 94 ms,
// 32 KB 380 ms — a clean 4x per doubling), while `String.replace` with the
// same pattern happens to hit a JSC fast path and stays linear. So this test
// does NOT reproduce a slowdown the old line actually exhibited on Bun; it
// pins the property that line was relying on an engine optimisation for —
// `stripQuotedTail` stays linear in the length of the whitespace it trims —
// which a refactor to `.test()`/`.exec()`, or any new `$`-anchored scan over
// attacker-controlled body text, would break.
//
// A correctness test cannot see any of this: the OUTPUT is right either way.
// Only the SHAPE of the time curve across input doublings separates O(n) from
// O(n²), so that is what is asserted.
// ---------------------------------------------------------------------------

/** Four sizes = three doublings. Linear predicts ~8x end to end, quadratic ~64x. */
const GROWTH_SIZES = [8_000, 16_000, 32_000, 64_000] as const;
/** Repeats per size, so the linear timings are milliseconds rather than noise. */
const GROWTH_REPEATS = 50;
const GROWTH_MAX_END_TO_END = 16;
/**
 * Per-size ceiling. The linear form runs the whole 50-repeat batch in well
 * under 50 ms even at 64 KB; the quadratic form blows this at the FIRST size,
 * so a regression fails fast instead of hanging the suite.
 */
const GROWTH_PER_SIZE_CEILING_MS = 500;

function timeAcrossDoublings(build: (n: number) => string): number[] {
  const timings: number[] = [];
  for (const n of GROWTH_SIZES) {
    const input = build(n);
    // Warm the JIT (and prove the result is what the caller expects) outside
    // the measured batch, so the batch times the trim and nothing else.
    let sink = stripQuotedTail(input).length;
    const startedAt = performance.now();
    for (let i = 0; i < GROWTH_REPEATS; i += 1) {
      sink += stripQuotedTail(input).length;
    }
    const elapsedMs = performance.now() - startedAt;
    expect(sink).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(GROWTH_PER_SIZE_CEILING_MS);
    timings.push(elapsedMs);
  }
  return timings;
}

test("a long trailing whitespace run on the kept region costs linear, not quadratic, time", () => {
  // Both an INTERNAL whitespace run and a trailing one: the internal run is
  // what makes a `$`-anchored greedy scan restart-and-fail repeatedly, the
  // trailing one is what the trim actually has to remove.
  const build = (n: number): string =>
    `Reply.${" ".repeat(n)}done.${" ".repeat(n)}\n> quoted original`;
  // Correctness first: the trailing run is stripped and the quote is cut.
  expect(stripQuotedTail(build(4))).toBe("Reply.    done.");

  const timings = timeAcrossDoublings(build);
  const first = timings[0] ?? 0;
  const last = timings[timings.length - 1] ?? 0;
  // Floor the baseline so a fast machine measuring the smallest size near the
  // clock's resolution cannot manufacture a huge ratio out of noise.
  expect(last / Math.max(first, 0.5)).toBeLessThan(GROWTH_MAX_END_TO_END);
});
