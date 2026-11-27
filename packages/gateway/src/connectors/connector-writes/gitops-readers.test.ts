import { describe, expect, test } from "bun:test";

import { selectSnowflakeTag } from "./gitops-readers.ts";

const TAG_NOW = "Tag now";
const UNIDENTIFIED = "unknown (the read does not identify this tag uniquely)";

type TagEntry = { database?: string; schema?: string; name?: string; value?: string };

function tagNow(tags: readonly TagEntry[], tag?: string): string {
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

// Connectors 0.21.0: each entry carries the tag's stored database, schema and bare name.
describe("selectSnowflakeTag: the identified reply (database, schema, name)", () => {
  const right = { database: "DB", schema: "S", name: "PII", value: "high" };
  const other = { database: "DB", schema: "OTHER", name: "PII", value: "secret-other" };

  test("the right tag's value is shown, matched on the three stored names", () => {
    expect(tagNow([right], "db.s.pii")).toContain("high");
    expect(tagNow([other, right], "DB.S.PII")).toContain("high");
    expect(tagNow([right, other], "DB.S.PII")).not.toContain("secret-other");
  });

  test("a same-named tag in another schema or database is not mistaken for it", () => {
    expect(tagNow([other], "DB.S.PII")).toBe("(not set)");
    expect(tagNow([{ ...right, database: "DB2", value: "x" }], "DB.S.PII")).toBe("(not set)");
  });

  test("stored names are compared as they are: a quoted lower-case name is another tag", () => {
    expect(
      tagNow([{ database: "DB", schema: "S", name: "pii", value: "v" }], 'DB.S."pii"'),
    ).toContain("v");
    expect(tagNow([{ database: "DB", schema: "S", name: "pii", value: "v" }], "DB.S.PII")).toBe(
      "(not set)",
    );
    // A stored name holding a dot is one segment, never re-parsed.
    expect(
      tagNow([{ database: "DB", schema: "S", name: "a.b", value: "v" }], 'DB.S."a.b"'),
    ).toContain("v");
  });

  test("a bare tag in the write still cannot be tied to one entry", () => {
    expect(tagNow([right], "PII")).toBe(UNIDENTIFIED);
  });

  test("the same identified tag twice cannot be told apart", () => {
    expect(tagNow([right, { ...right, value: "low" }], "DB.S.PII")).toBe(UNIDENTIFIED);
  });

  test("every tag on the table is listed by its qualified name", () => {
    const fields = selectSnowflakeTag(
      { object: "DB.S.T", tags: [right, other] },
      { tag: "DB.S.PII" },
    );
    expect(fields.find((f) => f.label === "All tags on the table")?.value).toBe(
      "DB.S.PII=high, DB.OTHER.PII=secret-other",
    );
  });

  test("a stored segment that is not a plain identifier is shown quoted, so two tags never read alike", () => {
    const allTags = (tags: readonly TagEntry[]): string | undefined =>
      selectSnowflakeTag({ object: "DB.S.T", tags }, { tag: "DB.S.PII" }).find(
        (f) => f.label === "All tags on the table",
      )?.value;
    expect(
      allTags([
        { database: "DB", schema: "S.X", name: "PII", value: "a" },
        { database: "DB", schema: "S", name: "X.PII", value: "b" },
      ]),
    ).toBe('DB."S.X".PII=a, DB.S."X.PII"=b');
    // Lower case, a leading digit and an embedded quote (doubled) are quoted; plain names are not.
    expect(allTags([{ database: "DB_1", schema: "s", name: 'Say "hi"', value: "v" }])).toBe(
      'DB_1."s"."Say ""hi"""=v',
    );
    expect(allTags([{ database: "DB", schema: "9S", name: "A$B", value: "v" }])).toBe(
      'DB."9S".A$B=v',
    );
  });

  test("an entry missing its schema falls back to parsing its name", () => {
    expect(tagNow([{ database: "DB", name: "DB.S.PII", value: "v" }], "DB.S.PII")).toContain("v");
  });
});
