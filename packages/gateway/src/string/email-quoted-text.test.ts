import { expect, test } from "bun:test";

import { stripQuotedTail } from "./email-quoted-text.ts";

test("cuts a trailing > quote block", () => {
  expect(stripQuotedTail("Yes, agreed.\n\n> the original\n> more original")).toBe("Yes, agreed.");
});

test("does NOT cut an inline quote followed by more prose", () => {
  const body =
    "Here's my take.\n\n> quoting the spec\n> more spec\n\nActually I disagree because Z.";
  expect(stripQuotedTail(body)).toBe(body);
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

test("a lone From: line in a pasted log does not trigger the header marker", () => {
  const body = "Log follows:\n\nFrom: cache\nstatus=200\ndone";
  expect(stripQuotedTail(body)).toBe(body);
});

test("a header block mid-message with prose below is not cut", () => {
  const body = "See below.\n\nFrom: Ana\nSent: Tue\n\nMy actual point is Z.";
  expect(stripQuotedTail(body)).toBe(body);
});

test("cuts a trailing signature delimiter", () => {
  expect(stripQuotedTail("Thanks!\n\n-- \nAna\nCTO")).toBe("Thanks!");
});

test("returns the body unchanged when no marker matches", () => {
  expect(stripQuotedTail("Just a plain message.")).toBe("Just a plain message.");
});

test("a wholly-quoted body falls back to the untrimmed text", () => {
  const body = "> everything\n> is quoted";
  expect(stripQuotedTail(body)).toBe(body);
});

test("handles CRLF line endings", () => {
  expect(stripQuotedTail("Yes.\r\n\r\n> quoted")).toBe("Yes.");
});

test("cuts at an attribution the client wrapped across two lines", () => {
  const body =
    "Agreed.\n\nOn Mon, Aug 3, 2026 at 4:32 PM User\n<user@example.com> wrote:\n> the thread";
  expect(stripQuotedTail(body)).toBe("Agreed.");
});

test("an attribution in the KEPT region is not reflowed into one line", () => {
  // The wrap-join is analysis-only; the returned text must be sliced from the
  // original lines, not the joined ones.
  const body = "On Mon, Aug 3, 2026 at 4:32 PM User\n<user@example.com> wrote:\n\nMy actual reply.";
  expect(stripQuotedTail(body)).toBe(body);
});

test("a terminal-marker cut still slices from the ORIGINAL lines", () => {
  // The other join+cut test (above) returns through the early "no marker at
  // all" exit and never reaches the slice, so it doesn't actually guard the
  // analysis-only-join property. This one's cut is driven by the terminal-
  // marker path, which is where a `lines.slice` (joined-text) regression
  // would actually be visible.
  const body =
    "On Mon, Aug 3, 2026 at 4:32 PM User\n<user@example.com> wrote:\n\nMy reply.\n\n-- \nAna";
  expect(stripQuotedTail(body)).toBe(
    "On Mon, Aug 3, 2026 at 4:32 PM User\n<user@example.com> wrote:\n\nMy reply.",
  );
});

test("an opener with no closer within the wrap budget is left alone", () => {
  const body = "On the whole\nI think we should\nship it\nand see.";
  expect(stripQuotedTail(body)).toBe(body);
});

test("empty input is returned as-is", () => {
  expect(stripQuotedTail("")).toBe("");
});

test("a terminal marker followed by a further quote tail cuts at the marker, not below it", () => {
  const body = "Thanks.\n\n-- \nAna\n\n> old text\n> more old";
  expect(stripQuotedTail(body)).toBe("Thanks.");
});

test("a quote tail running into a terminal signature marker cuts at the walk's earlier index", () => {
  const body = "Reply.\n\n> old quote\n> more quote\n-- ";
  expect(stripQuotedTail(body)).toBe("Reply.");
});

test("a body that is ONLY a signature block returns untrimmed, never empty", () => {
  const body = "-- \nAna\nCTO";
  expect(stripQuotedTail(body)).toBe(body);
});

test("a body that is ONLY an -----Original Message----- block returns untrimmed, never empty", () => {
  const body = "-----Original Message-----\nFrom: x";
  expect(stripQuotedTail(body)).toBe(body);
});

test("three hyphens is not a signature delimiter", () => {
  const body = "Thanks!\n\n---\nnot a delimiter";
  expect(stripQuotedTail(body)).toBe(body);
});

test("an author's own horizontal rule with prose below is NOT treated as terminal", () => {
  // A 10+ underscore rule is an ordinary human formatting idiom. Treating it
  // as unconditionally terminal (as `-----Original Message-----` and `-- `
  // genuinely are) silently deleted the whole rest of the message. Its
  // Outlook meaning is "a quoted header block follows" — nothing follows here
  // but the author's own prose, so nothing may be cut.
  const body = `Intro\n\n${"_".repeat(10)}\n\nSection two body text\nmore text`;
  expect(stripQuotedTail(body)).toBe(body);
});

test("a divider followed by a > quote block IS terminal", () => {
  // The other half of the gate: the divider does introduce a quoted block, so
  // it keeps its terminal status.
  expect(stripQuotedTail(`Ack.\n\n${"_".repeat(32)}\n> the original thread`)).toBe("Ack.");
});

test("fewer than 10 underscores is not a divider", () => {
  const body = `Body.\n\n${"_".repeat(9)}\nnot header`;
  expect(stripQuotedTail(body)).toBe(body);
});

test("a terminal marker appearing twice cuts at the LAST one", () => {
  const body = "A.\n\n-----Original Message-----\nFrom: x\n\n-----Original Message-----\nFrom: y";
  expect(stripQuotedTail(body)).toBe("A.\n\n-----Original Message-----\nFrom: x");
});

test("a signature delimiter WITH the trailing space cuts", () => {
  expect(stripQuotedTail("Thanks.\n\n-- \nAna")).toBe("Thanks.");
});

test("a bare -- with no trailing space does NOT cut", () => {
  // A false positive here would silently delete real prose (e.g. a
  // Setext-style heading underline); prefer the false negative.
  const body = "Thanks.\n\n--\nnot a signature, just two dashes.";
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

test("a divider immediately followed by a quote (no prose in between) still cuts, even via the walk path", () => {
  // The walk's own `isMarker` gate (not just the terminal scan) must honour
  // the same adjacency rule: dropping DIVIDER_RE from `isMarker` entirely
  // (CodeRabbit's literal suggested diff) would leave a divider that
  // genuinely precedes a quote sitting in the KEPT text instead of being
  // stripped along with the quote below it.
  expect(stripQuotedTail(`Intro\n${"_".repeat(12)}\n> real quote`)).toBe("Intro");
});

test("a bare trailing divider with nothing quoted below it is not treated as a marker", () => {
  // CodeRabbit also flagged that `isMarker` accepted a bare trailing divider
  // unconditionally. With nothing below it at all, the divider must not
  // qualify, so the walk never even reaches it as a "marker".
  const body = "Real content\nMore of it\n__________";
  expect(stripQuotedTail(body)).toBe(body);
});

test("a blank line between the divider and the quoted block does not break adjacency", () => {
  // "First nonblank line below" — blank lines in between must not count
  // against qualification.
  expect(stripQuotedTail(`Ack.\n\n${"_".repeat(12)}\n\n> the original thread`)).toBe("Ack.");
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
  // property the false-positive test above asserts, at scale.
  expect(result).toBe(body);
  expect(elapsedMs).toBeLessThan(1000);
});
