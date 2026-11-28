import { describe, expect, test } from "bun:test";

import { FocusCsvError } from "./focus-csv.ts";
import { focusFileText } from "./focus-file-text.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("focusFileText", () => {
  test("plain UTF-8 text", () => {
    expect(focusFileText(enc("a,b\n1,2\n"), "x.csv")).toBe("a,b\n1,2\n");
  });

  test("gunzips by name and by magic bytes", () => {
    const gz = Bun.gzipSync(enc("a,b\n1,é\n"));
    expect(focusFileText(gz, "export-00001.csv.gz")).toBe("a,b\n1,é\n");
    expect(focusFileText(gz, "no-extension")).toBe("a,b\n1,é\n");
  });

  test("a .gz name over bytes that are not gzip is refused", () => {
    expect(() => focusFileText(enc("a,b\n"), "x.csv.gz")).toThrow(FocusCsvError);
  });

  test("invalid UTF-8 is refused", () => {
    expect(() => focusFileText(Uint8Array.from([0x61, 0xff, 0xfe]), "x.csv")).toThrow(
      "not valid UTF-8",
    );
  });
});
