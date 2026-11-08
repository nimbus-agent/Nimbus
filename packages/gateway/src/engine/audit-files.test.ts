// packages/gateway/src/engine/audit-files.test.ts
import { describe, expect, test } from "bun:test";
import { omitFileText } from "./audit-files.ts";

const FILES = [
  { path: "a.ts", content: "héllo" },
  { path: "b.md", content: "x" },
];

describe("omitFileText", () => {
  test("nested: files become a count and the UTF-8 size; everything else is kept", () => {
    const payload = { mcpToolId: "t", input: { owner: "o", message: "m", files: FILES } };
    expect(omitFileText(payload)).toEqual({
      mcpToolId: "t",
      input: { owner: "o", message: "m", files: { count: 2, contentBytes: 7 } },
    });
    // The original is untouched.
    expect(payload.input.files).toBe(FILES);
  });

  test("flat: the same at the payload root", () => {
    expect(omitFileText({ owner: "o", files: FILES })).toEqual({
      owner: "o",
      files: { count: 2, contentBytes: 7 },
    });
  });

  test("no list, an empty list, or entries that are not path/content pairs: undefined", () => {
    for (const p of [
      {},
      { files: [] },
      { files: "x" },
      { files: [{ path: "a" }] },
      { files: [{ content: "a" }] },
      { files: [{ path: 1, content: "a" }] },
      { files: [null] },
      { input: { files: [{ path: "a", content: 5 }] } },
      { input: "not an object", files: undefined },
    ]) {
      expect(omitFileText(p as never), JSON.stringify(p)).toBeUndefined();
    }
  });

  test("a non-object input falls back to the root list", () => {
    expect(omitFileText({ input: "x", files: FILES })).toEqual({
      input: "x",
      files: { count: 2, contentBytes: 7 },
    });
  });
});
