import { describe, expect, test } from "bun:test";

import { selectSnowflakeTag } from "./gitops-readers.ts";

const TAG_NOW = "Tag now";
const UNIDENTIFIED = "unknown (the read does not identify this tag uniquely)";

function tagNow(tags: readonly { name?: string; value?: string }[], tag?: string): string {
  const fields = selectSnowflakeTag({ object: "DB.S.T", tags }, tag === undefined ? {} : { tag });
  return fields.find((f) => f.label === TAG_NOW)?.value ?? "";
}

describe("selectSnowflakeTag: identifying the tag the write names", () => {
  test("a reply entry naming the same fully-qualified tag shows its value", () => {
    expect(tagNow([{ name: "DB.S.PII", value: "yes" }], "db.s.pii")).toContain("yes");
  });

  test("a quoted segment keeps its case and an escaped quote", () => {
    expect(
      tagNow([{ name: 'DB.S."Mixed ""Q"" Tag"', value: "v1" }], 'db.s."Mixed ""Q"" Tag"'),
    ).toContain("v1");
    // A quoted lower-case name is a different tag from the upper-cased unquoted one: not this tag.
    expect(tagNow([{ name: 'DB.S."pii"', value: "v1" }], "DB.S.PII")).toBe("(not set)");
  });

  test("an entry that shares only the name (another schema, a bare name) is never shown as this tag's", () => {
    expect(tagNow([{ name: "DB.OTHER.PII", value: "secret" }], "DB.S.PII")).toBe(UNIDENTIFIED);
    expect(tagNow([{ name: "PII", value: "secret" }], "DB.S.PII")).toBe(UNIDENTIFIED);
    expect(tagNow([{ name: "DB.S.PII", value: "secret" }], "PII")).toBe(UNIDENTIFIED);
  });

  test("two entries for the same tag cannot be told apart", () => {
    expect(
      tagNow(
        [
          { name: "DB.S.PII", value: "a" },
          { name: "db.s.pii", value: "b" },
        ],
        "DB.S.PII",
      ),
    ).toBe(UNIDENTIFIED);
  });

  test("no entry sharing the name reads as not set", () => {
    expect(tagNow([{ name: "DB.S.OTHER", value: "x" }], "DB.S.PII")).toBe("(not set)");
  });

  test("a matching entry without a value says so", () => {
    expect(tagNow([{ name: "DB.S.PII" }], "DB.S.PII")).toContain("(no value)");
  });

  test.each([
    ["an unterminated quote", 'DB.S."PII'],
    ["an empty segment", "DB..PII"],
    ["a quote inside an unquoted segment", 'DB.S.P"II'],
    ["a quoted segment followed by text", 'DB."S"x.PII'],
    ["a trailing dot", "DB.S."],
  ])("a tag name that does not parse (%s) is unidentified, never guessed", (_n, tag) => {
    expect(tagNow([{ name: "DB.S.PII", value: "x" }], tag)).toBe(UNIDENTIFIED);
  });

  test("an unparseable name in the reply never matches", () => {
    expect(tagNow([{ name: 'DB.S."broken', value: "x" }, { value: "no name" }], "DB.S.PII")).toBe(
      "(not set)",
    );
  });

  test("no tag in the write: the value is not set, not unidentified", () => {
    expect(tagNow([{ name: "DB.S.PII", value: "x" }])).toBe("(not set)");
  });

  test("a reply without a tags list is refused", () => {
    expect(() => selectSnowflakeTag({ object: "DB.S.T" }, { tag: "DB.S.PII" })).toThrow("no tags");
  });
});
