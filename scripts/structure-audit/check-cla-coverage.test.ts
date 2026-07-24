import { describe, expect, test } from "bun:test";

import { diffClaCoverage } from "./check-cla-coverage.ts";

const REPOS = ["Nimbus", "nimbus-sdk", "nimbus-client"];

describe("diffClaCoverage", () => {
  test("passes when all repos have cla.yml at the same version", () => {
    const r = diffClaCoverage(REPOS, {
      Nimbus: "version1",
      "nimbus-sdk": "version1",
      "nimbus-client": "version1",
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("flags a repo missing cla.yml", () => {
    const r = diffClaCoverage(REPOS, {
      Nimbus: "version1",
      "nimbus-sdk": null,
      "nimbus-client": "version1",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("nimbus-sdk");
    expect(r.errors.join("\n")).toContain("no cla.yml");
  });

  test("flags a version mismatch across repos", () => {
    const r = diffClaCoverage(REPOS, {
      Nimbus: "version1",
      "nimbus-sdk": "version2",
      "nimbus-client": "version1",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("version");
    expect(r.errors.join("\n")).toContain("nimbus-sdk");
  });

  test("flags a repo whose cla.yml has no recognizable version", () => {
    const r = diffClaCoverage(REPOS, {
      Nimbus: "version1",
      "nimbus-sdk": "version1",
      "nimbus-client": "",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("nimbus-client");
  });
});
