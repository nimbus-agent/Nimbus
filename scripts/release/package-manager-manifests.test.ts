/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { parseSha256Sums } from "./package-manager-manifests.ts";

describe("parseSha256Sums", () => {
  test("parses `<hash>  <filename>` lines into a filename→hash map", () => {
    const text = [
      "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111  nimbus-headless-macos-arm64.tar.gz",
      "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222  nimbus-headless-windows-x64.zip",
      "",
    ].join("\n");
    const map = parseSha256Sums(text);
    expect(map.get("nimbus-headless-macos-arm64.tar.gz")).toBe(
      "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
    );
    expect(map.get("nimbus-headless-windows-x64.zip")).toBe(
      "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
    );
  });
  test("tolerates single-space separators and ignores blank lines", () => {
    const map = parseSha256Sums(
      "cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333 file.tar.gz\n\n",
    );
    expect(map.get("file.tar.gz")).toBe(
      "cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333",
    );
  });
});
