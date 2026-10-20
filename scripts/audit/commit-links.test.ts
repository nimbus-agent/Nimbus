import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { extractCommitLinks, findProblems, shallowVerdict } from "./commit-links.ts";

const REPO = "https://github.com/nimbus-agent/Nimbus/commit";

describe("extractCommitLinks", () => {
  test("finds full and short shas with their line, lower-cased", () => {
    const text = `a\n* x ([#1](${REPO}/ABCDEF1234567890abcdef1234567890ABCDEF12))\n* y ${REPO}/0407fb0 and ${REPO}/9f9215b#diff`;
    expect(extractCommitLinks("C.md", text).map((l) => [l.line, l.sha])).toEqual([
      [2, "abcdef1234567890abcdef1234567890abcdef12"],
      [3, "0407fb0"],
      [3, "9f9215b"],
    ]);
  });

  test("a link under the prefix that is not a 7-40 hex sha is kept with sha null", () => {
    const text = `${REPO}/abc12 ${REPO}/abc1234zz ${REPO}/`;
    expect(extractCommitLinks("C.md", text).map((l) => [l.ref, l.sha])).toEqual([
      ["abc12", null],
      ["abc1234zz", null],
      ["", null],
    ]);
  });

  test("ignores other repos and compare links", () => {
    const text = [
      "https://github.com/nimbus-agent/nimbus-sdk/commit/0407fb0c1410a15435c3e170b113a6163db8518e",
      "https://github.com/nimbus-agent/Nimbus/compare/v9.2.1...v10.0.0",
    ].join("\n");
    expect(extractCommitLinks("C.md", text)).toEqual([]);
  });
});

describe("findProblems", () => {
  test("reports absent shas and non-sha links, asking about each sha once", () => {
    const asked: string[][] = [];
    const links = extractCommitLinks(
      "C.md",
      `${REPO}/aaaaaaa\n${REPO}/bbbbbbb\n${REPO}/aaaaaaa\n${REPO}/abc12`,
    );
    const problems = findProblems(links, (shas) => {
      asked.push([...shas]);
      return new Set(["bbbbbbb"]);
    });
    expect(asked).toEqual([["aaaaaaa", "bbbbbbb"]]);
    expect(problems.map((p) => [p.link.line, p.reason])).toEqual([
      [1, "missing"],
      [3, "missing"],
      [4, "not_a_sha"],
    ]);
  });

  test("nothing reported when every sha exists", () => {
    const links = extractCommitLinks("C.md", `${REPO}/aaaaaaa`);
    expect(findProblems(links, () => new Set(["aaaaaaa"]))).toEqual([]);
  });
});

describe("shallowVerdict", () => {
  test("a full clone always runs", () => {
    expect(shallowVerdict(false, "true")).toBe("run");
    expect(shallowVerdict(false, undefined)).toBe("run");
  });

  test("a shallow clone fails closed in CI and skips locally", () => {
    expect(shallowVerdict(true, "true")).toBe("fail");
    expect(shallowVerdict(true, undefined)).toBe("skip");
    expect(shallowVerdict(true, "false")).toBe("skip");
  });
});

describe("lychee.toml", () => {
  test("excludes ONLY this repo's commit permalinks, anchored, which this audit covers instead", () => {
    const toml = readFileSync(join(import.meta.dir, "..", "..", "lychee.toml"), "utf8");
    const lines = toml
      .split("\n")
      .filter((l) => l.includes("/commit/") && !l.trim().startsWith("#"));
    expect(lines.map((l) => l.trim())).toEqual([
      '"^https://github\\\\.com/nimbus-agent/Nimbus/commit/",',
    ]);
  });
});
