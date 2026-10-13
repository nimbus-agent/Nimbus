import { describe, expect, test } from "bun:test";

import { BODY_MAX_PROSE } from "../index/body-caps.ts";
import {
  CAPTURE_KINDS,
  CAPTURE_STATES,
  CaptureError,
  isCaptureKind,
  isCaptureState,
} from "./capture-types.ts";
import { sanitizeClientLabel, validateNotePayload } from "./capture-validate.ts";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
  throw new Error("expected a CaptureError");
}

describe("validateNotePayload", () => {
  test("rebuilds from named fields only — unknown sibling keys never survive", () => {
    const p = validateNotePayload({ title: "t", body: "b", junk: "x", __proto__: { evil: 1 } });
    expect(p).toEqual({ title: "t", body: "b", tags: [], relatesTo: [] });
    expect(Object.keys(p).sort()).toEqual(["body", "relatesTo", "tags", "title"]);
  });

  test("prose truncates: title at 200, body at BODY_MAX_PROSE", () => {
    const p = validateNotePayload({
      title: "t".repeat(500),
      body: "b".repeat(BODY_MAX_PROSE + 10),
    });
    expect(p.title).toHaveLength(200);
    expect(p.body).toHaveLength(BODY_MAX_PROSE);
  });

  test("a max-length NON-ASCII body truncates instead of tripping the 64 KiB payload cap", () => {
    const p = validateNotePayload({ title: "日本", body: "語".repeat(BODY_MAX_PROSE + 100) });
    expect(p.body).toHaveLength(BODY_MAX_PROSE);
  });

  test("an empty or missing title becomes (untitled)", () => {
    expect(validateNotePayload({ title: "   ", body: "b" }).title).toBe("(untitled)");
    expect(validateNotePayload({ body: "b" }).title).toBe("(untitled)");
  });

  test.each([
    ["not an object", "x"],
    ["null", null],
    ["an array", []],
    ["missing body", { title: "t" }],
    ["blank body", { title: "t", body: "  \n " }],
    ["non-string body", { title: "t", body: 3 }],
    ["non-string title", { title: 3, body: "b" }],
    ["11 tags", { body: "b", tags: Array.from({ length: 11 }, (_, i) => `t${String(i)}`) }],
    ["a 51-char tag", { body: "b", tags: ["x".repeat(51)] }],
    ["a non-string tag", { body: "b", tags: [1] }],
    ["a blank tag", { body: "b", tags: ["  "] }],
    ["tags not an array", { body: "b", tags: "a" }],
    [
      "11 relatesTo",
      { body: "b", relatesTo: Array.from({ length: 11 }, (_, i) => `github:${String(i)}`) },
    ],
    ["an empty relatesTo id", { body: "b", relatesTo: [""] }],
    ["relatesTo not an array", { body: "b", relatesTo: "github:1" }],
  ])("structured fields REFUSE: %s", (_n, raw) => {
    expect(code(() => validateNotePayload(raw))).toBe("ERR_CAPTURE_INVALID");
  });

  test("a rebuilt payload over 64 KiB of UTF-8 JSON refuses", () => {
    // Every field at its cap in 3-byte characters: 16384*3 + 10*512*3 + 10*50*3 + 200*3 > 65536.
    const refs = Array.from({ length: 10 }, (_, i) => `${String(i)}${"語".repeat(511)}`);
    const tags = Array.from({ length: 10 }, (_, i) => `${String(i)}${"語".repeat(49)}`);
    expect(
      code(() =>
        validateNotePayload({
          title: "語".repeat(200),
          body: "語".repeat(BODY_MAX_PROSE),
          tags,
          relatesTo: refs,
        }),
      ),
    ).toBe("ERR_CAPTURE_INVALID");
  });

  test("control characters are stripped at write time: all of them in the title, all but \\t\\n\\r in the body", () => {
    const p = validateNotePayload({
      title: "a\u001b[2Jb\nc",
      body: "x\u001b]0;pwn\u0007y\n\tz\r\n",
    });
    expect(p.title).toBe("a[2Jbc");
    expect(p.body).toBe("x]0;pwny\n\tz\r\n");
  });

  test("a body made only of control characters is empty, so refused", () => {
    expect(code(() => validateNotePayload({ body: "\u001b\u0007" }))).toBe("ERR_CAPTURE_INVALID");
  });

  test("tags and relatesTo are trimmed and de-duplicated, order kept", () => {
    const p = validateNotePayload({ body: "b", tags: [" a", "a", "b"], relatesTo: ["x:1", "x:1"] });
    expect(p.tags).toEqual(["a", "b"]);
    expect(p.relatesTo).toEqual(["x:1"]);
  });
});

describe("sanitizeClientLabel", () => {
  test("strips control characters and truncates to 100", () => {
    expect(sanitizeClientLabel("claude\u001b[31m-code\n")).toBe("claude[31m-code");
    expect(sanitizeClientLabel("x".repeat(150))).toHaveLength(100);
  });

  test("non-strings and empty labels become null", () => {
    expect(sanitizeClientLabel(undefined)).toBeNull();
    expect(sanitizeClientLabel(42)).toBeNull();
    expect(sanitizeClientLabel("\u0007")).toBeNull();
  });
});

describe("capture-types guards", () => {
  test("isCaptureKind / isCaptureState accept members and reject everything else", () => {
    for (const k of CAPTURE_KINDS) expect(isCaptureKind(k)).toBe(true);
    for (const s of CAPTURE_STATES) expect(isCaptureState(s)).toBe(true);
    expect(isCaptureKind("memo")).toBe(false);
    expect(isCaptureKind(3)).toBe(false);
    expect(isCaptureState("pending")).toBe(false);
    expect(isCaptureState(null)).toBe(false);
  });

  test("CaptureError carries code and prefixes the message", () => {
    const e = new CaptureError("ERR_CAPTURE_STATE", "nope");
    expect(e.code).toBe("ERR_CAPTURE_STATE");
    expect(e.message).toBe("ERR_CAPTURE_STATE: nope");
  });
});
