import { describe, expect, test } from "bun:test";

import { classifyDiff, isVersionOnlyChange, releaseManagedFiles } from "./release-only-diff.ts";

// The repository's own config (.release-please-config.json as of v7.47.0).
const CONFIG = {
  packages: {
    ".": {
      "release-type": "node",
      "changelog-path": "CHANGELOG.md",
      "extra-files": ["packages/gateway/src/version.ts", "CLAUDE.md", "GEMINI.md"],
    },
  },
};

const MANAGED = releaseManagedFiles(CONFIG);

// `git diff --unified=0 39c70ad3^ 39c70ad3` — the real v7.47.0 release PR (#1674), changelog
// hunk trimmed.
const RELEASE_DIFF = `diff --git a/.release-please-manifest.json b/.release-please-manifest.json
index 0e199733..b18a2190 100644
--- a/.release-please-manifest.json
+++ b/.release-please-manifest.json
@@ -2 +2 @@
-  ".": "7.46.0"
+  ".": "7.47.0"
diff --git a/CHANGELOG.md b/CHANGELOG.md
index 1111111..2222222 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -3,0 +4,7 @@
+## [7.47.0](https://github.com/nimbus-agent/Nimbus/compare/v7.46.0...v7.47.0) (2026-10-16)
+
+### Features
+
+* **ui:** read-only desktop Captures page ([#1672](https://github.com/nimbus-agent/Nimbus/issues/1672))
+
+
diff --git a/CLAUDE.md b/CLAUDE.md
index b61f1c3a..1a55b42e 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -10 +10 @@ Nimbus is a **local-first AI agent framework**: a headless Bun Gateway that main
-**Latest release:** \`v7.46.0\` <!-- x-release-please-version -->
+**Latest release:** \`v7.47.0\` <!-- x-release-please-version -->
diff --git a/GEMINI.md b/GEMINI.md
index 467e41e8..e996c6b2 100644
--- a/GEMINI.md
+++ b/GEMINI.md
@@ -10 +10 @@ Nimbus is a **local-first AI agent framework**: a headless Bun Gateway that main
-**Latest release:** \`v7.46.0\` <!-- x-release-please-version -->
+**Latest release:** \`v7.47.0\` <!-- x-release-please-version -->
diff --git a/package.json b/package.json
index eb8334db..a211281f 100644
--- a/package.json
+++ b/package.json
@@ -3 +3 @@
-  "version": "7.46.0",
+  "version": "7.47.0",
diff --git a/packages/gateway/src/version.ts b/packages/gateway/src/version.ts
index 79a51c34..8208fbd3 100644
--- a/packages/gateway/src/version.ts
+++ b/packages/gateway/src/version.ts
@@ -4 +4 @@
-export const GATEWAY_VERSION = "7.46.0"; // x-release-please-version
+export const GATEWAY_VERSION = "7.47.0"; // x-release-please-version
`;

describe("releaseManagedFiles", () => {
  test("names the manifest, each package's package.json, extra-files and changelog", () => {
    expect([...MANAGED.versionFiles].sort()).toEqual([
      ".release-please-manifest.json",
      "CLAUDE.md",
      "GEMINI.md",
      "package.json",
      "packages/gateway/src/version.ts",
    ]);
    expect([...MANAGED.changelogs]).toEqual(["CHANGELOG.md"]);
  });

  test("resolves a nested package's files under its path, and object-form extra-files", () => {
    const m = releaseManagedFiles({
      packages: {
        "packages/sdk": { "extra-files": [{ type: "json", path: "meta.json" }] },
      },
    });
    expect(m.versionFiles.has("packages/sdk/package.json")).toBe(true);
    expect(m.versionFiles.has("packages/sdk/meta.json")).toBe(true);
    expect(m.changelogs.has("packages/sdk/CHANGELOG.md")).toBe(true);
  });

  test("an unreadable config manages nothing — which makes every diff a full run", () => {
    const m = releaseManagedFiles("not an object");
    expect(m.versionFiles.size).toBe(1); // the manifest only
    expect(m.changelogs.size).toBe(0);
  });
});

describe("isVersionOnlyChange", () => {
  test("a line that differs only in its version string is a bump", () => {
    expect(isVersionOnlyChange(['  "version": "7.46.0",'], ['  "version": "7.47.0",'])).toBe(true);
  });

  test("prerelease and build suffixes are part of the version", () => {
    expect(isVersionOnlyChange(["v1.2.3-rc.1"], ["v1.2.4+build.7"])).toBe(true);
  });

  test("any other edit on the same line is not", () => {
    expect(
      isVersionOnlyChange(
        ['export const GATEWAY_VERSION = "7.46.0";'],
        ['export const GATEWAY_VERSION = "7.47.0"; doSomething();'],
      ),
    ).toBe(false);
  });

  test("an added line with no removed partner is not", () => {
    expect(isVersionOnlyChange([], ["const x = 1;"])).toBe(false);
    expect(isVersionOnlyChange(["a 1.0.0"], ["a 1.0.1", "b"])).toBe(false);
  });
});

describe("classifyDiff", () => {
  test("the real v7.47.0 release PR is release-only", () => {
    expect(classifyDiff(RELEASE_DIFF, MANAGED)).toEqual({
      releaseOnly: true,
      reason: "6 file(s), every change a version bump or a changelog entry",
    });
  });

  test("a file outside the release-managed set is not", () => {
    const diff = `${RELEASE_DIFF}diff --git a/packages/gateway/src/x.ts b/packages/gateway/src/x.ts
index 1..2 100644
--- a/packages/gateway/src/x.ts
+++ b/packages/gateway/src/x.ts
@@ -1 +1 @@
-a
+b
`;
    const r = classifyDiff(diff, MANAGED);
    expect(r.releaseOnly).toBe(false);
    expect(r.reason).toContain("packages/gateway/src/x.ts");
  });

  test("code smuggled into a managed file is not", () => {
    const diff = RELEASE_DIFF.replace(
      '+export const GATEWAY_VERSION = "7.47.0"; // x-release-please-version',
      '+export const GATEWAY_VERSION = "7.47.0"; // x-release-please-version\n+import "./evil.ts";',
    );
    const r = classifyDiff(diff, MANAGED);
    expect(r.releaseOnly).toBe(false);
    expect(r.reason).toContain("packages/gateway/src/version.ts");
  });

  test("a new, deleted, renamed or binary file is not", () => {
    for (const marker of [
      "new file mode 100644",
      "deleted file mode 100644",
      "rename from package.json",
      "Binary files a/package.json and b/package.json differ",
      "old mode 100644",
    ]) {
      const diff = `diff --git a/package.json b/package.json\n${marker}\n`;
      expect(classifyDiff(diff, MANAGED).releaseOnly).toBe(false);
    }
  });

  test("a path git had to quote is not", () => {
    const diff = `diff --git "a/CLAUDE\\303\\251.md" "b/CLAUDE\\303\\251.md"\n--- a\n+++ b\n@@ -1 +1 @@\n-1.0.0\n+1.0.1\n`;
    expect(classifyDiff(diff, MANAGED).releaseOnly).toBe(false);
  });

  test("an empty diff is not — a full run is the safe answer to nothing", () => {
    expect(classifyDiff("", MANAGED).releaseOnly).toBe(false);
  });

  test("ignores git's 'no newline' marker and hunk-header context", () => {
    const diff = `diff --git a/package.json b/package.json
index 1..2 100644
--- a/package.json
+++ b/package.json
@@ -3 +3 @@ "name": "nimbus",
-  "version": "1.0.0",
\\ No newline at end of file
+  "version": "1.0.1",
\\ No newline at end of file
`;
    expect(classifyDiff(diff, MANAGED).releaseOnly).toBe(true);
  });
});
