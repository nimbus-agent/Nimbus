import { describe, expect, test } from "bun:test";

import {
  matchesBumpPr,
  parseNpmLatest,
  resolvedFromBunLock,
  selectTaggedRelease,
  stripTrailingCommas,
} from "./_release-train-dep.ts";

describe("parseNpmLatest", () => {
  const doc = JSON.stringify({
    "dist-tags": { latest: "0.12.1" },
    time: { "0.12.0": "2026-07-20T00:00:00Z", "0.12.1": "2026-07-24T12:36:40.942Z" },
  });
  test("reads dist-tags.latest and its publish time", () => {
    expect(parseNpmLatest(doc)).toEqual({
      version: "0.12.1",
      publishedAt: "2026-07-24T12:36:40.942Z",
    });
  });
  test("null when dist-tags is absent", () => {
    expect(parseNpmLatest(JSON.stringify({ time: {} }))).toBeNull();
  });
  test("null when the latest version has no time entry", () => {
    expect(
      parseNpmLatest(JSON.stringify({ "dist-tags": { latest: "1.0.0" }, time: {} })),
    ).toBeNull();
  });
  test("null on malformed JSON", () => {
    expect(parseNpmLatest("{not json")).toBeNull();
  });
});

describe("selectTaggedRelease", () => {
  const base = { draft: false, prerelease: false, assets: [] as string[] };
  const P = "^sdk-v(\\d+\\.\\d+\\.\\d+)$";
  test("picks the highest component-prefixed tag and returns its publish time", () => {
    const r = selectTaggedRelease(
      [
        { ...base, tag: "sdk-v1.5.2", publishedAt: "2026-07-01T00:00:00Z" },
        { ...base, tag: "sdk-v1.6.0", publishedAt: "2026-07-10T00:00:00Z" },
      ],
      P,
    );
    expect(r).toEqual({ version: "1.6.0", publishedAt: "2026-07-10T00:00:00Z" });
  });
  test("ignores tags that do not match the pattern", () => {
    const r = selectTaggedRelease(
      [
        { ...base, tag: "v9.9.9", publishedAt: "2026-07-10T00:00:00Z" },
        { ...base, tag: "client-v0.1.0", publishedAt: "2026-07-10T00:00:00Z" },
        { ...base, tag: "sdk-v1.0.0", publishedAt: "2026-07-01T00:00:00Z" },
      ],
      P,
    );
    expect(r?.version).toBe("1.0.0");
  });
  test("skips drafts and prereleases", () => {
    const r = selectTaggedRelease(
      [
        { ...base, tag: "sdk-v2.0.0", draft: true, publishedAt: "2026-07-10T00:00:00Z" },
        { ...base, tag: "sdk-v1.9.0", prerelease: true, publishedAt: "2026-07-10T00:00:00Z" },
        { ...base, tag: "sdk-v1.6.0", publishedAt: "2026-07-01T00:00:00Z" },
      ],
      P,
    );
    expect(r?.version).toBe("1.6.0");
  });
  test("null when nothing matches", () => {
    expect(selectTaggedRelease([{ ...base, tag: "v1.0.0", publishedAt: "x" }], P)).toBeNull();
  });
});

describe("resolvedFromBunLock", () => {
  // Mirrors the real bun.lock shape: workspaces carry RANGES, packages carry
  // resolutions whose element [0] is "<name>@<version>". Trailing commas are
  // legal in a real bun.lock, so one is included deliberately.
  const lock = `{
    "lockfileVersion": 1,
    "workspaces": {
      "": { "name": "nimbus" },
      "packages/cli": { "name": "@nimbus/cli", "dependencies": { "@nimbus-dev/sdk": "^1.5.0" } },
      "packages/mcp-connectors/github": { "name": "nimbus-mcp-github" },
    },
    "packages": {
      "@nimbus-dev/sdk": ["@nimbus-dev/sdk@1.6.0", "", {}, "sha512-aaa"],
      "nimbus-mcp-github/@nimbus-dev/sdk": ["@nimbus-dev/sdk@1.4.0", "", {}, "sha512-bbb"],
      "@nimbus-dev/client/@nimbus-dev/sdk": ["@nimbus-dev/sdk@1.3.0", "", {}, "sha512-ccc"],
    },
  }`;

  test("takes the minimum across our OWN workspaces, ignoring third-party nesting", () => {
    // 1.4.0 (our workspace) wins over 1.6.0 (hoisted); 1.3.0 is nested under the
    // external @nimbus-dev/client and must NOT count.
    expect(resolvedFromBunLock(lock, "@nimbus-dev/sdk")).toBe("1.4.0");
  });

  test("hoisted-only lockfile returns the hoisted version", () => {
    const simple = `{
      "workspaces": { "": { "name": "x" } },
      "packages": { "@nimbus-dev/sdk": ["@nimbus-dev/sdk@1.6.0", "", {}, "sha512-a"] }
    }`;
    expect(resolvedFromBunLock(simple, "@nimbus-dev/sdk")).toBe("1.6.0");
  });

  test("a range in the workspaces section is never read as a resolution", () => {
    // The only mention of the package is a "^1.5.0" range — no resolution entry.
    const rangeOnly = `{
      "workspaces": { "p": { "name": "p", "dependencies": { "@nimbus-dev/sdk": "^1.5.0" } } },
      "packages": {}
    }`;
    expect(resolvedFromBunLock(rangeOnly, "@nimbus-dev/sdk")).toBeNull();
  });

  test("null when the package is absent entirely", () => {
    expect(resolvedFromBunLock(lock, "@nimbus-dev/nope")).toBeNull();
  });

  test("null on unparseable lockfile", () => {
    expect(resolvedFromBunLock("{not json", "@nimbus-dev/sdk")).toBeNull();
  });
});

describe("stripTrailingCommas", () => {
  test("removes trailing commas before } and ]", () => {
    expect(JSON.parse(stripTrailingCommas('{"a":[1,2,],"b":{"c":1,},}'))).toEqual({
      a: [1, 2],
      b: { c: 1 },
    });
  });
  test("does NOT touch a comma inside a string value", () => {
    // The naive regex /,(\s*[}\]])/g corrupts this silently — it parses, but
    // with the comma eaten. That is the bug this function exists to avoid.
    const src = JSON.stringify({ note: "a comma, }" });
    expect(JSON.parse(stripTrailingCommas(src)).note).toBe("a comma, }");
  });
  test("handles escaped quotes inside strings", () => {
    const src = '{"k":"he said \\", }"}';
    expect(JSON.parse(stripTrailingCommas(src)).k).toBe('he said ", }');
  });
});

describe("matchesBumpPr", () => {
  const pkg = "@nimbus-dev/sdk";
  test("matches the full package name in a title", () => {
    expect(
      matchesBumpPr([{ title: "Bump @nimbus-dev/sdk from 1.5.0 to 1.6.0", headRefName: "x" }], pkg),
    ).toBe(true);
  });
  test("matches the short name in a title, case-insensitively", () => {
    expect(
      matchesBumpPr([{ title: "chore(deps): upgrade SDK to 1.6.0", headRefName: "x" }], pkg),
    ).toBe(true);
  });
  test("matches the branch name when the title does not mention it", () => {
    expect(
      matchesBumpPr(
        [{ title: "chore: deps", headRefName: "dependabot/npm_and_yarn/nimbus-dev/sdk-1.6.0" }],
        pkg,
      ),
    ).toBe(true);
  });
  test("an unrelated open PR does not count as an in-flight bump", () => {
    expect(matchesBumpPr([{ title: "fix: typo in README", headRefName: "fix/readme" }], pkg)).toBe(
      false,
    );
  });
  test("no open PRs => false", () => {
    expect(matchesBumpPr([], pkg)).toBe(false);
  });
});
