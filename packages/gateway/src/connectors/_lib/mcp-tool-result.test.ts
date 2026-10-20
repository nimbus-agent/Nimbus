import { describe, expect, test } from "bun:test";
import { extractMcpToolText } from "./mcp-tool-result.ts";

describe("extractMcpToolText", () => {
  test("returns the first text part", () => {
    expect(extractMcpToolText({ content: [{ type: "text", text: "hi" }] }, 10)).toBe("hi");
  });
  test("rejects isError", () => {
    expect(() =>
      extractMcpToolText({ isError: true, content: [{ type: "text", text: "boom" }] }, 10),
    ).toThrow(/error: boom/);
  });
  test("rejects a missing text part and non-objects", () => {
    expect(() => extractMcpToolText({ content: [] }, 10)).toThrow(/shape/);
    expect(() => extractMcpToolText({ content: [{ type: "image" }] }, 10)).toThrow(/shape/);
    expect(() => extractMcpToolText("x", 10)).toThrow(/shape/);
  });
  test("rejects text over the byte cap (UTF-8 bytes, not chars)", () => {
    expect(() => extractMcpToolText({ content: [{ text: "ééé" }] }, 5)).toThrow(/cap/);
    expect(extractMcpToolText({ content: [{ text: "ééé" }] }, 6)).toBe("ééé");
  });
});
