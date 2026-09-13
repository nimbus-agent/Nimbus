import { describe, expect, test } from "bun:test";
import {
  finiteNumberField,
  metadataRecord,
  nonEmptyStringField,
  stringArrayField,
} from "./item-metadata.ts";

/**
 * These guards are reached indirectly by every standup and oncall lane, which is exactly why
 * they need tests of their own: a lane test that passes proves the HAPPY path through them, and
 * every guard returns the same shape on malformed input that the caller already handles — so
 * removing one changes no lane assertion. `coverage-floor` caught the module these came from at
 * 72.73% branch before they existed.
 */

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

describe("nonEmptyStringField", () => {
  test("returns a non-empty string", () => {
    expect(nonEmptyStringField({ severity: "P1" }, "severity")).toBe("P1");
  });

  test("an EMPTY string is null, matching what the connector omitting the key means", () => {
    // `pagerduty-sync.ts` omits `severity`/`urgency`/`pagerduty_service_id` entirely when the
    // source value is blank, so a blank arriving by another route means the same thing — no
    // value. Returning `""` here would render as a severity of "" beside a populated one.
    expect(nonEmptyStringField({ severity: "" }, "severity")).toBeNull();
  });

  test("a non-string is null rather than coerced", () => {
    expect(nonEmptyStringField({ severity: 1 }, "severity")).toBeNull();
    expect(nonEmptyStringField({ severity: null }, "severity")).toBeNull();
    expect(nonEmptyStringField({ severity: ["P1"] }, "severity")).toBeNull();
    expect(nonEmptyStringField({}, "severity")).toBeNull();
  });
});

describe("stringArrayField", () => {
  test("returns the string members", () => {
    expect(stringArrayField({ assignee_emails: ["a@x", "b@x"] }, "assignee_emails")).toEqual([
      "a@x",
      "b@x",
    ]);
  });

  test("a missing or non-array value is the EMPTY array, never null", () => {
    // `assignee_emails` is written unconditionally by the connector, so the empty array is the
    // honest representation of "nobody is assigned". A `null` would force every caller to
    // re-decide what that means.
    expect(stringArrayField({}, "assignee_emails")).toEqual([]);
    expect(stringArrayField({ assignee_emails: null }, "assignee_emails")).toEqual([]);
    expect(stringArrayField({ assignee_emails: "a@x" }, "assignee_emails")).toEqual([]);
  });

  test("non-string and empty members are DROPPED, not coerced", () => {
    // `String(42)` would render as an assignee named "42".
    expect(stringArrayField({ a: [42, "b@x", null, "", { e: 1 }] }, "a")).toEqual(["b@x"]);
  });
});
