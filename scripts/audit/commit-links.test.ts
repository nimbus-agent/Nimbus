import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { extractCommitLinks, findMissing } from "./commit-links.ts";

const REPO = "https://github.com/nimbus-agent/Nimbus/commit";

describe("extractCommitLinks", () => {
  test("finds full and short shas with their line, lower-cased", () => {
    const text = `a\n* x ([#1](${REPO}/ABCDEF1234567890abcdef1234567890ABCDEF12))\n* y ${REPO}/0407fb0 and ${REPO}/9f9215b`;
    expect(extractCommitLinks("C.md", text)).toEqual([
      { file: "C.md", line: 2, sha: "abcdef1234567890abcdef1234567890abcdef12" },
      { file: "C.md", line: 3, sha: "0407fb0" },
      { file: "C.md", line: 3, sha: "9f9215b" },
    ]);
  });

  test("ignores other repos, compare links and too-short shas", () => {
    const text = [
      "https://github.com/nimbus-agent/nimbus-sdk/commit/0407fb0c1410a15435c3e170b113a6163db8518e",
      "https://github.com/nimbus-agent/Nimbus/compare/v9.2.1...v10.0.0",
      `${REPO}/abc12`,
    ].join("\n");
    expect(extractCommitLinks("C.md", text)).toEqual([]);
  });
});

describe("findMissing", () => {
  test("reports every link to an absent sha and asks about each sha once", () => {
    const asked: string[][] = [];
    const links = extractCommitLinks("C.md", `${REPO}/aaaaaaa\n${REPO}/bbbbbbb\n${REPO}/aaaaaaa`);
    const missing = findMissing(links, (shas) => {
      asked.push([...shas]);
      return new Set(["bbbbbbb"]);
    });
    expect(asked).toEqual([["aaaaaaa", "bbbbbbb"]]);
    expect(missing.map((m) => m.line)).toEqual([1, 3]);
  });

  test("nothing missing when every sha exists", () => {
    const links = extractCommitLinks("C.md", `${REPO}/aaaaaaa`);
    expect(findMissing(links, () => new Set(["aaaaaaa"]))).toEqual([]);
  });
});

describe("lychee.toml", () => {
  test("excludes ONLY this repo's commit permalinks, which this audit covers instead", () => {
    const toml = readFileSync(join(import.meta.dir, "..", "..", "lychee.toml"), "utf8");
    const line = toml.split("\n").find((l) => l.includes("/commit/"));
    expect(line?.trim().startsWith('"github\\\\.com/nimbus-agent/Nimbus/commit/')).toBe(true);
  });
});
