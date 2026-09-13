import { describe, expect, test } from "bun:test";
import { basisCanBeMisplaced } from "./standup-time-basis.ts";

/**
 * Reached indirectly by every standup lane, which is exactly why it needs a test of its own: a
 * lane test that passes proves the HAPPY path through it, and the predicate returns a plain
 * boolean the caller already handles — so inverting an arm changes no lane assertion.
 * `coverage-floor` caught this file at 72.73% branch before these existed.
 *
 * The two JSON guards that used to live here moved to `item-metadata.ts` when `oncall` needed
 * them; their tests moved with them to `item-metadata.test.ts`.
 */
describe("basisCanBeMisplaced", () => {
  test("only last_touch can be misplaced", () => {
    // The ONE definition of the predicate: `standup.ts` counts rows with it and
    // `brief-disclosures.ts` decides whether to emit the disclosure from that count, so the
    // number the reader sees and the sentence explaining it cannot disagree about which entries
    // are meant. All three arms asserted, because inverting any one of them silently changes
    // what the brief claims.
    expect(basisCanBeMisplaced("last_touch")).toBe(true);
    expect(basisCanBeMisplaced("event_field")).toBe(false);
    // `event_column` is the interesting one: its timestamp DOES come from `item.modified_at`, so
    // a predicate written as "not event_field" would wrongly include it and inflate the
    // disclosure with entries its warning does not apply to.
    expect(basisCanBeMisplaced("event_column")).toBe(false);
  });
});
