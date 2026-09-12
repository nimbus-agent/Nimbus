import { describe, expect, test } from "bun:test";
import { basisCanBeMisplaced, finiteNumberField, metadataRecord } from "./standup-time-basis.ts";

/**
 * These three helpers are reached indirectly by every standup lane, which is exactly why they
 * need tests of their own: a lane test that passes proves the HAPPY path through them, and every
 * guard here returns the same shape on malformed input that the caller already handles — so
 * removing one changes no lane assertion. `coverage-floor` caught this file at 72.73% branch
 * before these existed.
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

describe("finiteNumberField", () => {
  test("returns a finite number", () => {
    expect(finiteNumberField({ merged_at: 1_700_000_000_000 }, "merged_at")).toBe(
      1_700_000_000_000,
    );
    // Zero is a legitimate epoch value and must not be confused with absence.
    expect(finiteNumberField({ merged_at: 0 }, "merged_at")).toBe(0);
    // Negative epochs are pre-1970 and legitimate.
    expect(finiteNumberField({ created_at_ms: -86_400_000 }, "created_at_ms")).toBe(-86_400_000);
  });

  test("rejects a STRING that SQLite would have compared as in-window", () => {
    // The reason this function exists. `json_extract` returns whatever the JSON held, and SQLite
    // sorts every text value ABOVE every number, so an ISO string passes `>= fromMs` for any
    // window. Without this check the row is admitted with `atMs` set to a string.
    expect(finiteNumberField({ merged_at: "2026-09-11T00:00:00Z" }, "merged_at")).toBeNull();
    expect(finiteNumberField({ merged_at: "1700000000000" }, "merged_at")).toBeNull();
  });

  test("rejects non-finite numbers", () => {
    // A NaN timestamp reads as a real value everywhere downstream — `github-sync.ts` makes the
    // same point about writing nothing rather than `NaN`.
    expect(finiteNumberField({ merged_at: Number.NaN }, "merged_at")).toBeNull();
    expect(finiteNumberField({ merged_at: Number.POSITIVE_INFINITY }, "merged_at")).toBeNull();
    expect(finiteNumberField({ merged_at: Number.NEGATIVE_INFINITY }, "merged_at")).toBeNull();
  });

  test("rejects every other type, and an absent key", () => {
    expect(finiteNumberField({}, "merged_at")).toBeNull();
    expect(finiteNumberField({ merged_at: null }, "merged_at")).toBeNull();
    expect(finiteNumberField({ merged_at: true }, "merged_at")).toBeNull();
    expect(finiteNumberField({ merged_at: { ms: 1 } }, "merged_at")).toBeNull();
    expect(finiteNumberField({ merged_at: [1] }, "merged_at")).toBeNull();
  });
});

describe("metadataRecord", () => {
  test("parses a JSON object into a record", () => {
    expect(metadataRecord('{"state":"open","number":7}')).toEqual({ state: "open", number: 7 });
    // An empty object is a valid record, distinct from `null`.
    expect(metadataRecord("{}")).toEqual({});
  });

  test("a NULL column is null, not a throw", () => {
    // `item.metadata` is nullable and several connectors leave it unset.
    expect(metadataRecord(null)).toBeNull();
  });

  test("unparseable JSON is null, not a throw", () => {
    expect(metadataRecord("not json")).toBeNull();
    expect(metadataRecord("")).toBeNull();
    expect(metadataRecord("{unclosed")).toBeNull();
  });

  test("a JSON ARRAY is rejected, not read as an object with absent keys", () => {
    // The case the doc comment names: `json_valid` accepts `[1,2]`, and indexing a key on an
    // array yields `undefined` rather than failing — so without this guard an array-valued
    // `metadata` reads as "the field is absent" instead of "this row is malformed", and the row
    // is silently admitted with a wrong timestamp basis.
    expect(metadataRecord("[1,2]")).toBeNull();
    expect(metadataRecord("[]")).toBeNull();
  });

  test("JSON scalars and literal null are rejected", () => {
    // `JSON.parse("null")` succeeds and returns `null`, so the `parsed === null` arm is reached
    // through a PARSE rather than through the early `raw === null` return — a different branch.
    expect(metadataRecord("null")).toBeNull();
    expect(metadataRecord("42")).toBeNull();
    expect(metadataRecord('"a string"')).toBeNull();
    expect(metadataRecord("true")).toBeNull();
  });
});
