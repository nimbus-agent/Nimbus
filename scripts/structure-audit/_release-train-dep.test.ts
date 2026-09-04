import { describe, expect, test } from "bun:test";

import {
  type ConsumerReading,
  evaluatePackage,
  matchesBumpPr,
  parseNpmLatest,
  parseReleaseList,
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

const consumer = (over: Partial<ConsumerReading>): ConsumerReading => ({
  repo: "nimbus-agent/nimbus-vscode",
  status: "read",
  resolved: null,
  bumpPrOpen: false,
  ...over,
});

describe("evaluatePackage", () => {
  const green = {
    name: "sdk",
    npm: "@nimbus-dev/sdk",
    taggedRelease: { version: "1.6.0", publishedAt: "x" },
    taggedReleaseAgeHours: 48,
    taggedReleaseListStatus: "read" as const,
    latest: { version: "1.6.0", publishedAt: "x" },
    latestAgeHours: 48,
    graceHours: 6,
  };

  test("tag and npm equal + consumer current => all ok", () => {
    const r = evaluatePackage({
      ...green,
      consumers: [consumer({ resolved: "1.6.0" })],
    });
    expect(r.every((e) => e.verdict === "ok")).toBe(true);
  });

  test("tag ahead of npm past grace => publish phantom", () => {
    const r = evaluatePackage({
      ...green,
      taggedRelease: { version: "1.7.0", publishedAt: "x" },
      consumers: [],
    });
    expect(r.find((e) => e.edge === "sdk:publish")?.verdict).toBe("phantom");
  });

  test("tag ahead of npm within grace => ok (publish window)", () => {
    const r = evaluatePackage({
      ...green,
      taggedRelease: { version: "1.7.0", publishedAt: "x" },
      taggedReleaseAgeHours: 1,
      consumers: [],
    });
    expect(r.find((e) => e.edge === "sdk:publish")?.verdict).toBe("ok");
  });

  test("consumer behind past grace => stale", () => {
    const r = evaluatePackage({ ...green, consumers: [consumer({ resolved: "1.5.2" })] });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("stale");
  });

  test("consumer behind but the npm version is within grace => ok", () => {
    const r = evaluatePackage({
      ...green,
      latestAgeHours: 2,
      consumers: [consumer({ resolved: "1.5.2" })],
    });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("ok");
  });

  test("consumer behind but a bump PR is open => ok", () => {
    const r = evaluatePackage({
      ...green,
      consumers: [consumer({ resolved: "1.5.2", bumpPrOpen: true })],
    });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("ok");
  });

  test("consumer behind but the PR list was unreadable => indeterminate, not stale", () => {
    const r = evaluatePackage({
      ...green,
      consumers: [consumer({ resolved: "1.5.2", bumpPrOpen: null })],
    });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("indeterminate");
  });

  test("consumer ahead of npm => ok, never stale", () => {
    const r = evaluatePackage({ ...green, consumers: [consumer({ resolved: "1.7.0" })] });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("ok");
  });

  test("npm unreadable => every edge indeterminate, never stale", () => {
    const r = evaluatePackage({
      ...green,
      latest: null,
      latestAgeHours: null,
      consumers: [consumer({ resolved: "1.0.0" })],
    });
    expect(r.every((e) => e.verdict === "indeterminate")).toBe(true);
  });

  test("transient consumer read => indeterminate", () => {
    const r = evaluatePackage({
      ...green,
      consumers: [consumer({ status: "indeterminate" })],
    });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("indeterminate");
  });

  test("absent lockfile => stale", () => {
    const r = evaluatePackage({ ...green, consumers: [consumer({ status: "absent" })] });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("stale");
  });

  test("lockfile parsed but package is not a dependency => indeterminate naming the manifest", () => {
    const r = evaluatePackage({
      ...green,
      consumers: [consumer({ status: "not-a-dependency" })],
    });
    const e = r.find((x) => x.edge === "sdk:nimbus-vscode");
    expect(e?.verdict).toBe("indeterminate");
    expect(e?.detail).toContain("manifest error");
    expect(e?.detail).toContain("release-train.json");
  });

  test("unparseable resolved version => indeterminate, never a crash", () => {
    const r = evaluatePackage({
      ...green,
      consumers: [consumer({ resolved: "not-a-version" })],
    });
    expect(r.find((e) => e.edge === "sdk:nimbus-vscode")?.verdict).toBe("indeterminate");
  });

  test("no tagged release AND the list was unreadable => indeterminate, not phantom", () => {
    const r = evaluatePackage({
      ...green,
      taggedRelease: null,
      taggedReleaseAgeHours: null,
      taggedReleaseListStatus: "indeterminate" as const,
      consumers: [],
    });
    expect(r.find((e) => e.edge === "sdk:publish")?.verdict).toBe("indeterminate");
  });

  /**
   * The regression this pair exists for. `release-train.json` shipped the sdk
   * train with `^sdk-v(...)$` while the upstream repo tags `typescript-v*`, so
   * the pattern matched nothing — and because that produced `indeterminate`,
   * which `decideExit` renders as a warning and exits 0 on, the edge announced
   * no problem for as long as it was broken. A readable list that matched
   * nothing is a manifest bug and must be reported as hard as any other.
   */
  test("no tagged release but the list WAS readable => stale (manifest bug), not indeterminate", () => {
    const r = evaluatePackage({
      ...green,
      taggedRelease: null,
      taggedReleaseAgeHours: null,
      taggedReleaseListStatus: "read",
      consumers: [],
    });
    const edge = r.find((e) => e.edge === "sdk:publish");
    expect(edge?.verdict).toBe("stale");
    expect(edge?.detail).toContain("tagPattern");
  });

  /**
   * The SECOND fail-open on the same shape, caught in review on #1445: a 404
   * means the configured `repo` is gone, renamed, or misspelled. That edge can
   * never go green on its own, so warning about it is a permanent silence — the
   * same defect the tagPattern case had, one field over. `ConsumerReading`
   * already treats an absent lockfile as `stale`; this matches it.
   */
  test("a 404 on the upstream repo => stale (manifest bug), not indeterminate", () => {
    const r = evaluatePackage({
      ...green,
      taggedRelease: null,
      taggedReleaseAgeHours: null,
      taggedReleaseListStatus: "absent",
      consumers: [],
    });
    const edge = r.find((e) => e.edge === "sdk:publish");
    expect(edge?.verdict).toBe("stale");
    expect(edge?.detail).toContain("404");
  });

  test("an unknown-read caller keeps the old warning-only behaviour", () => {
    const r = evaluatePackage({
      ...green,
      taggedRelease: null,
      taggedReleaseAgeHours: null,
      taggedReleaseListStatus: null,
      consumers: [],
    });
    expect(r.find((e) => e.edge === "sdk:publish")?.verdict).toBe("indeterminate");
  });
});

describe("parseReleaseList", () => {
  const page = (rows: unknown[]) => JSON.stringify([rows]);
  const row = (over: Record<string, unknown> = {}) => ({
    tag_name: "typescript-v1.32.0",
    prerelease: false,
    draft: false,
    published_at: "2026-09-04T04:15:55Z",
    assets: [{ name: "SHA256SUMS" }],
    ...over,
  });

  test("flattens EVERY page, not just the first", () => {
    // The whole point of --paginate: nimbus-sdk releases three SDKs from one
    // repo, so the newest typescript-v* can sit behind a run of python/go tags.
    const text = JSON.stringify([
      [row({ tag_name: "python-v0.21.0" })],
      [row({ tag_name: "typescript-v1.32.0" })],
    ]);
    const rels = parseReleaseList(text);
    expect(rels?.map((r) => r.tag)).toEqual(["python-v0.21.0", "typescript-v1.32.0"]);
  });

  test("maps GitHub's field names and flattens asset names", () => {
    expect(parseReleaseList(page([row()]))?.[0]).toEqual({
      tag: "typescript-v1.32.0",
      prerelease: false,
      draft: false,
      publishedAt: "2026-09-04T04:15:55Z",
      assets: ["SHA256SUMS"],
    });
  });

  test("a DRAFT's null published_at is kept, not treated as malformed", () => {
    // Drafts legitimately have no publish date. Rejecting the row would let one
    // draft invalidate the entire list; every consumer filters drafts first.
    const rels = parseReleaseList(page([row({ draft: true, published_at: null })]));
    expect(rels?.[0]?.publishedAt).toBe("");
    expect(rels?.[0]?.draft).toBe(true);
  });

  test.each([
    ["a non-string tag", row({ tag_name: 42 })],
    ["a non-boolean draft", row({ draft: "no" })],
    ["a non-array assets", row({ assets: "none" })],
    ["an asset with no name", row({ assets: [{ label: "x" }] })],
    ["a non-object row", "not-a-release"],
  ])("returns null for %s — one bad row invalidates the list", (_label, bad) => {
    // Deliberately all-or-nothing: a SKIPPED row is indistinguishable from a repo
    // with no matching release, and that outcome is now a hard failure. Better to
    // lose the check for one run than to red the build with a wrong reason.
    expect(parseReleaseList(page([row(), bad]))).toBeNull();
  });

  test("returns null on malformed JSON and on a non-array body", () => {
    expect(parseReleaseList("{not json")).toBeNull();
    expect(parseReleaseList('{"message":"Not Found"}')).toBeNull();
  });
});
