import { describe, expect, test } from "bun:test";

import { replyFromMcpResult } from "./eval-reply.ts";

const BAD = { kind: "failed", reason: "bad-reply" } as const;

describe("replyFromMcpResult", () => {
  test("text blocks are joined with a newline", () => {
    expect(
      replyFromMcpResult({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toEqual({ kind: "reply", text: "a\nb", isError: false });
  });

  test("non-text blocks and malformed text blocks are ignored", () => {
    expect(
      replyFromMcpResult({
        content: [
          { type: "image", data: "xx", mimeType: "image/png" },
          { type: "text", text: "only" },
          { type: "text", text: 7 },
          null,
          "text",
        ],
      }),
    ).toEqual({ kind: "reply", text: "only", isError: false });
  });

  test("an empty content array is an empty reply", () => {
    expect(replyFromMcpResult({ content: [] })).toEqual({
      kind: "reply",
      text: "",
      isError: false,
    });
  });

  test("isError: true is carried; absent or non-true is false", () => {
    expect(replyFromMcpResult({ content: [{ type: "text", text: "x" }], isError: true })).toEqual({
      kind: "reply",
      text: "x",
      isError: true,
    });
    expect(replyFromMcpResult({ content: [], isError: "true" })).toEqual({
      kind: "reply",
      text: "",
      isError: false,
    });
  });

  test("null, a non-object, no content, or content not an array ⇒ bad-reply", () => {
    expect(replyFromMcpResult(null)).toEqual(BAD);
    expect(replyFromMcpResult(undefined)).toEqual(BAD);
    expect(replyFromMcpResult("text")).toEqual(BAD);
    expect(replyFromMcpResult({})).toEqual(BAD);
    expect(replyFromMcpResult({ content: "text" })).toEqual(BAD);
    expect(replyFromMcpResult({ content: { 0: { type: "text", text: "x" } } })).toEqual(BAD);
    expect(replyFromMcpResult([{ type: "text", text: "x" }])).toEqual(BAD);
  });
});
