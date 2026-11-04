import { describe, expect, test } from "bun:test";
import { authorMetadataLines, fundingEntryLines } from "./author-metadata-lines.ts";

const ESC = String.fromCodePoint(0x1b);

describe("authorMetadataLines", () => {
  test("nothing declared", () => {
    expect(authorMetadataLines({})).toEqual(["License: not declared", "Funding: none"]);
    expect(authorMetadataLines({ funding: null, license: null })).toEqual([
      "License: not declared",
      "Funding: none",
    ]);
  });

  test("invalid markers", () => {
    expect(authorMetadataLines({ fundingInvalid: true, licenseInvalid: true })).toEqual([
      "License: (invalid, ignored)",
      "Funding: (invalid, ignored)",
    ]);
  });

  test("a license and numbered funding entries, label optional", () => {
    expect(
      authorMetadataLines({
        license: "MIT OR Apache-2.0",
        funding: [
          { url: "https://github.com/sponsors/a", label: "GitHub" },
          { url: "https://x.org/y" },
        ],
      }),
    ).toEqual([
      "License: MIT OR Apache-2.0",
      "Funding:",
      "  1. GitHub https://github.com/sponsors/a",
      "  2. https://x.org/y",
    ]);
  });

  test("strings are cleaned", () => {
    const lines = authorMetadataLines({
      license: `MIT${ESC}[2J`,
      funding: [{ url: "https://x.org/y", label: `a${ESC}[2Jb` }],
    });
    expect(lines).toEqual(["License: MIT[2J", "Funding:", "  1. a[2Jb https://x.org/y"]);
  });

  test("a funding list with no valid entry reads none", () => {
    expect(authorMetadataLines({ funding: [{ url: "http://insecure.example" }] })[1]).toBe(
      "Funding: none",
    );
  });
});

describe("fundingEntryLines", () => {
  test("drops failing entries and numbers over the kept ones", () => {
    expect(
      fundingEntryLines([
        { url: "javascript:alert(1)" },
        { url: "https://a.example/x", label: "A" },
        { url: "https://b.example/x" },
      ]),
    ).toEqual(["  1. A https://a.example/x", "  2. https://b.example/x"]);
  });

  test("cleans the label", () => {
    const [l] = fundingEntryLines([{ url: "https://a.example/x", label: `A${ESC}[2J` }]);
    expect(l).not.toContain(ESC);
  });
});
