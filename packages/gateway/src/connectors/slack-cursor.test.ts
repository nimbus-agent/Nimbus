import { describe, expect, test } from "bun:test";

import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import {
  decodeSlackCursor,
  encodeSlackCursor,
  readSlackSelfUserId,
  SLACK_CURSOR_PREFIX,
  type SlackSyncCursorV1,
} from "./slack-cursor.ts";

const BASE: SlackSyncCursorV1 = {
  phase: "history",
  floorTs: "1700000000.000000",
  ids: ["C1", "D2"],
  nextIdx: 1,
  hw: { C1: "1700000100.000200", D2: null },
  listCursor: "lc",
  histCursor: "hc",
  teamSubdomain: "acme",
  selfUserId: "U1",
  mkIdx: 7,
  listPartial: false,
};

function raw(payload: unknown): string {
  return encodeNimbusJsonCursor(SLACK_CURSOR_PREFIX, payload);
}

describe("slack cursor", () => {
  test("round trips every field, including selfUserId and mkIdx", () => {
    expect(decodeSlackCursor(encodeSlackCursor(BASE))).toEqual(BASE);
  });

  test("a cursor without the MB4 fields decodes with selfUserId null and mkIdx 0", () => {
    const { selfUserId: _s, mkIdx: _m, listPartial: _l, ...old } = BASE;
    const out = decodeSlackCursor(raw(old));
    expect(out).toEqual({ ...BASE, selfUserId: null, mkIdx: 0 });
  });

  test("listPartial round trips true and anything but true decodes to false", () => {
    expect(decodeSlackCursor(encodeSlackCursor({ ...BASE, listPartial: true }))?.listPartial).toBe(
      true,
    );
    for (const bad of ["true", 1, null]) {
      expect(decodeSlackCursor(raw({ ...BASE, listPartial: bad }))?.listPartial).toBe(false);
    }
  });

  test("a wrong-typed selfUserId or mkIdx decodes to the defaults", () => {
    for (const bad of [5, "", null, {}]) {
      expect(decodeSlackCursor(raw({ ...BASE, selfUserId: bad }))?.selfUserId).toBeNull();
    }
    for (const bad of ["3", -1, 1.5, null]) {
      expect(decodeSlackCursor(raw({ ...BASE, mkIdx: bad }))?.mkIdx).toBe(0);
    }
  });

  test("refuses what cannot be a cursor", () => {
    expect(decodeSlackCursor(null)).toBeNull();
    expect(decodeSlackCursor("")).toBeNull();
    expect(decodeSlackCursor("nimbus-other:abc")).toBeNull();
    expect(decodeSlackCursor(`${SLACK_CURSOR_PREFIX}%%%`)).toBeNull();
    expect(decodeSlackCursor(raw({ ...BASE, phase: "bogus" }))).toBeNull();
    expect(decodeSlackCursor(raw({ ...BASE, floorTs: "" }))).toBeNull();
    expect(decodeSlackCursor(raw({ ...BASE, floorTs: 5 }))).toBeNull();
    expect(decodeSlackCursor(raw({ ...BASE, ids: [1] }))).toBeNull();
    expect(decodeSlackCursor(raw({ ...BASE, ids: "C1" }))).toBeNull();
    expect(decodeSlackCursor(raw({ ...BASE, nextIdx: -1 }))).toBeNull();
    expect(decodeSlackCursor(raw({ ...BASE, nextIdx: 1.5 }))).toBeNull();
    expect(decodeSlackCursor(raw({ ...BASE, nextIdx: "1" }))).toBeNull();
    expect(decodeSlackCursor(raw([1, 2]))).toBeNull();
  });

  test("high-water: junk values become null, a non-object becomes empty", () => {
    expect(decodeSlackCursor(raw({ ...BASE, hw: { C1: 5, C2: "x" } }))?.hw).toEqual({
      C1: null,
      C2: "x",
    });
    expect(decodeSlackCursor(raw({ ...BASE, hw: [1] }))?.hw).toEqual({});
    expect(decodeSlackCursor(raw({ ...BASE, hw: null }))?.hw).toEqual({});
    expect(decodeSlackCursor(raw({ ...BASE, hw: "x" }))?.hw).toEqual({});
  });

  test("listCursor, histCursor and teamSubdomain of the wrong type decode to null", () => {
    const out = decodeSlackCursor(raw({ ...BASE, listCursor: 1, histCursor: 2, teamSubdomain: 3 }));
    expect(out?.listCursor).toBeNull();
    expect(out?.histCursor).toBeNull();
    expect(out?.teamSubdomain).toBeNull();
  });

  test("readSlackSelfUserId: null cursor, foreign prefix, none cached, valid", () => {
    expect(readSlackSelfUserId(null)).toBeNull();
    expect(readSlackSelfUserId("nimbus-other:abc")).toBeNull();
    expect(readSlackSelfUserId(encodeSlackCursor({ ...BASE, selfUserId: null }))).toBeNull();
    expect(readSlackSelfUserId(encodeSlackCursor(BASE))).toBe("U1");
  });
});
