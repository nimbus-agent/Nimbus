import { describe, expect, test } from "bun:test";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const PREFIX = "nimbus-test1:";

/** A cursor carrying `json` verbatim — payloads `encodeNimbusJsonCursor` would never write itself. */
function rawCursor(json: string): string {
  return PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

describe("decodeNimbusJsonCursorObject", () => {
  test("returns the payload of a cursor written under the same prefix", () => {
    const cursor = encodeNimbusJsonCursor(PREFIX, { since: "2026-10-01T00:00:00Z", page: 2 });
    expect(decodeNimbusJsonCursorObject(cursor, PREFIX)).toEqual({
      since: "2026-10-01T00:00:00Z",
      page: 2,
    });
  });

  test("returns null when there is no cursor, or an empty one", () => {
    expect(decodeNimbusJsonCursorObject(null, PREFIX)).toBeNull();
    expect(decodeNimbusJsonCursorObject("", PREFIX)).toBeNull();
  });

  test("returns null for a cursor another connector wrote", () => {
    const foreign = encodeNimbusJsonCursor("nimbus-other1:", { since: "2026-10-01T00:00:00Z" });
    expect(decodeNimbusJsonCursorObject(foreign, PREFIX)).toBeNull();
  });

  test("returns null when the payload is not JSON", () => {
    expect(decodeNimbusJsonCursorObject(`${PREFIX}!!!!`, PREFIX)).toBeNull();
    expect(decodeNimbusJsonCursorObject(rawCursor("{not json"), PREFIX)).toBeNull();
  });

  test.each(["null", "[1,2,3]", "[]", "42", '"text"', "true"])(
    "returns null when the payload decodes to %s rather than an object",
    (json) => {
      expect(decodeNimbusJsonCursorObject(rawCursor(json), PREFIX)).toBeNull();
    },
  );

  test("leaves field validation to the caller: an empty object is still an object", () => {
    expect(decodeNimbusJsonCursorObject(rawCursor("{}"), PREFIX)).toEqual({});
  });
});
