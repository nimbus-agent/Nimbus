import { describe, expect, test } from "bun:test";
import { encodeNimbusJsonCursor } from "../../nimbus-json-cursor.ts";
import {
  decodeGmailSyncCursor,
  encodeGmailSyncCursor,
  GMAIL_CURSOR_PREFIX,
  type GmailSyncCursorV1,
} from "./cursor.ts";

// Helper: encode an arbitrary object (not necessarily a valid cursor) with the
// Gmail prefix so that decodeNimbusJsonCursorPayload succeeds and the
// structural validation inside decodeGmailSyncCursor is exercised.
function encodeRaw(payload: unknown): string {
  return encodeNimbusJsonCursor(GMAIL_CURSOR_PREFIX, payload);
}

// ─── Round-trip: both phases ──────────────────────────────────────────────────

describe("encodeGmailSyncCursor / decodeGmailSyncCursor — round-trips", () => {
  test("list phase with string pageToken", () => {
    const cursor: GmailSyncCursorV1 = {
      v: 1,
      phase: "list",
      q: "newer_than:30d",
      pageToken: "tok1",
    };
    const encoded = encodeGmailSyncCursor(cursor);
    expect(encoded.startsWith(GMAIL_CURSOR_PREFIX)).toBe(true);
    expect(decodeGmailSyncCursor(encoded)).toEqual(cursor);
  });

  test("list phase with null pageToken", () => {
    const cursor: GmailSyncCursorV1 = {
      v: 1,
      phase: "list",
      q: "newer_than:30d",
      pageToken: null,
    };
    expect(decodeGmailSyncCursor(encodeGmailSyncCursor(cursor))).toEqual(cursor);
  });

  test("delta phase with string pageToken", () => {
    const cursor: GmailSyncCursorV1 = {
      v: 1,
      phase: "delta",
      startHistoryId: "42000",
      pageToken: "hp2",
    };
    const encoded = encodeGmailSyncCursor(cursor);
    expect(encoded.startsWith(GMAIL_CURSOR_PREFIX)).toBe(true);
    expect(decodeGmailSyncCursor(encoded)).toEqual(cursor);
  });

  test("delta phase with null pageToken", () => {
    const cursor: GmailSyncCursorV1 = {
      v: 1,
      phase: "delta",
      startHistoryId: "42000",
      pageToken: null,
    };
    expect(decodeGmailSyncCursor(encodeGmailSyncCursor(cursor))).toEqual(cursor);
  });
});

// ─── Top-level decode guards ──────────────────────────────────────────────────

describe("decodeGmailSyncCursor — top-level guards", () => {
  test("wrong prefix → undefined", () => {
    // decodeNimbusJsonCursorPayload returns undefined when prefix mismatches
    expect(decodeGmailSyncCursor("nimbus-other:eyJ2IjoxfQ")).toBeUndefined();
  });

  test("bad base64 after correct prefix → undefined", () => {
    expect(decodeGmailSyncCursor(`${GMAIL_CURSOR_PREFIX}!!!not-base64`)).toBeUndefined();
  });

  test("JSON is an array → undefined", () => {
    // encodeNimbusJsonCursor encodes the array; decodeNimbusJsonCursorPayload
    // returns it as-is; our guard (Array.isArray) rejects it.
    expect(decodeGmailSyncCursor(encodeRaw([1, 2, 3]))).toBeUndefined();
  });

  test("JSON is null → undefined", () => {
    expect(decodeGmailSyncCursor(encodeRaw(null))).toBeUndefined();
  });

  test("JSON is a string scalar → undefined", () => {
    expect(decodeGmailSyncCursor(encodeRaw("hello"))).toBeUndefined();
  });

  // L48: r["v"] !== 1
  test("v = 2 → undefined (wrong version)", () => {
    expect(
      decodeGmailSyncCursor(encodeRaw({ v: 2, phase: "list", q: "q", pageToken: null })),
    ).toBeUndefined();
  });

  test("v missing → undefined", () => {
    expect(
      decodeGmailSyncCursor(encodeRaw({ phase: "list", q: "q", pageToken: null })),
    ).toBeUndefined();
  });

  test("v = 1 but unknown phase → undefined", () => {
    expect(decodeGmailSyncCursor(encodeRaw({ v: 1, phase: "unknown", q: "q" }))).toBeUndefined();
  });

  test("v = 1 but phase missing → undefined", () => {
    expect(decodeGmailSyncCursor(encodeRaw({ v: 1, q: "q" }))).toBeUndefined();
  });
});

// ─── List phase structural guards ────────────────────────────────────────────

describe("decodeGmailSyncCursor — list phase structural guards", () => {
  // L16: typeof q !== "string"
  test("q is missing → undefined", () => {
    expect(
      decodeGmailSyncCursor(encodeRaw({ v: 1, phase: "list", pageToken: null })),
    ).toBeUndefined();
  });

  test("q is a number → undefined", () => {
    expect(
      decodeGmailSyncCursor(encodeRaw({ v: 1, phase: "list", q: 42, pageToken: null })),
    ).toBeUndefined();
  });

  // L19: pageToken !== null && typeof pageToken !== "string"
  test("pageToken is a number (non-null, non-string) → undefined", () => {
    expect(
      decodeGmailSyncCursor(
        encodeRaw({ v: 1, phase: "list", q: "newer_than:30d", pageToken: 999 }),
      ),
    ).toBeUndefined();
  });

  test("pageToken is an object → undefined", () => {
    expect(
      decodeGmailSyncCursor(encodeRaw({ v: 1, phase: "list", q: "newer_than:30d", pageToken: {} })),
    ).toBeUndefined();
  });

  test("pageToken is false → undefined", () => {
    expect(
      decodeGmailSyncCursor(
        encodeRaw({ v: 1, phase: "list", q: "newer_than:30d", pageToken: false }),
      ),
    ).toBeUndefined();
  });
});

// ─── Delta phase structural guards ───────────────────────────────────────────

describe("decodeGmailSyncCursor — delta phase structural guards", () => {
  // L28: typeof startHistoryId !== "string"
  test("startHistoryId missing → undefined", () => {
    expect(
      decodeGmailSyncCursor(encodeRaw({ v: 1, phase: "delta", pageToken: null })),
    ).toBeUndefined();
  });

  test("startHistoryId is a number → undefined", () => {
    expect(
      decodeGmailSyncCursor(
        encodeRaw({ v: 1, phase: "delta", startHistoryId: 100, pageToken: null }),
      ),
    ).toBeUndefined();
  });

  // L28: startHistoryId === ""
  test("startHistoryId is empty string → undefined", () => {
    expect(
      decodeGmailSyncCursor(
        encodeRaw({ v: 1, phase: "delta", startHistoryId: "", pageToken: null }),
      ),
    ).toBeUndefined();
  });

  // L31: pageToken !== null && typeof pageToken !== "string"
  test("delta pageToken is a number (non-null, non-string) → undefined", () => {
    expect(
      decodeGmailSyncCursor(
        encodeRaw({ v: 1, phase: "delta", startHistoryId: "100", pageToken: 0 }),
      ),
    ).toBeUndefined();
  });

  test("delta pageToken is true → undefined", () => {
    expect(
      decodeGmailSyncCursor(
        encodeRaw({ v: 1, phase: "delta", startHistoryId: "100", pageToken: true }),
      ),
    ).toBeUndefined();
  });

  test("delta pageToken is an array → undefined", () => {
    expect(
      decodeGmailSyncCursor(
        encodeRaw({ v: 1, phase: "delta", startHistoryId: "100", pageToken: [] }),
      ),
    ).toBeUndefined();
  });
});

// ─── GMAIL_CURSOR_PREFIX export ───────────────────────────────────────────────

describe("GMAIL_CURSOR_PREFIX", () => {
  test("has expected value", () => {
    expect(GMAIL_CURSOR_PREFIX).toBe("nimbus-gml1:");
  });

  test("encoded cursor always starts with prefix", () => {
    const cursor: GmailSyncCursorV1 = {
      v: 1,
      phase: "list",
      q: "test",
      pageToken: null,
    };
    expect(encodeGmailSyncCursor(cursor).startsWith(GMAIL_CURSOR_PREFIX)).toBe(true);
  });
});
