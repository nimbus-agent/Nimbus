import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { auditReleasePleaseManifest } from "./check-release-please-manifest.ts";

function makeRepo(layout: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "release-please-audit-"));
  for (const [relPath, contents] of Object.entries(layout)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf8");
  }
  return root;
}

describe("auditReleasePleaseManifest", () => {
  test("passes when manifest versions match package.json versions", () => {
    const root = makeRepo({
      ".release-please-manifest.json": JSON.stringify({
        ".": "0.1.0",
        "packages/example": "0.2.0",
      }),
      "package.json": JSON.stringify({ name: "nimbus", version: "0.1.0" }),
      "packages/example/package.json": JSON.stringify({
        name: "@nimbus-dev/example",
        version: "0.2.0",
      }),
    });
    const result = auditReleasePleaseManifest(root);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("fails when a manifest version drifts from package.json", () => {
    const root = makeRepo({
      ".release-please-manifest.json": JSON.stringify({
        ".": "0.1.0",
        "packages/example": "0.2.0",
      }),
      "package.json": JSON.stringify({ name: "nimbus", version: "0.1.0" }),
      "packages/example/package.json": JSON.stringify({
        name: "@nimbus-dev/example",
        version: "0.2.1",
      }),
    });
    const result = auditReleasePleaseManifest(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("packages/example");
    expect(result.errors[0]).toContain("0.2.0");
    expect(result.errors[0]).toContain("0.2.1");
  });

  test("fails when a manifest path is missing from disk", () => {
    const root = makeRepo({
      ".release-please-manifest.json": JSON.stringify({
        ".": "0.1.0",
        "packages/ghost": "1.0.0",
      }),
      "package.json": JSON.stringify({ name: "nimbus", version: "0.1.0" }),
    });
    const result = auditReleasePleaseManifest(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("packages/ghost");
    expect(result.errors[0]).toContain("missing");
  });

  test("fails when the manifest file itself is missing", () => {
    const root = makeRepo({
      "package.json": JSON.stringify({ name: "nimbus", version: "0.1.0" }),
    });
    const result = auditReleasePleaseManifest(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain(".release-please-manifest.json");
  });
});

/**
 * Regression cover for the #1184 release-manifest desync. release-please lost
 * its anchor tag, re-walked the whole history, picked up a stale
 * `Release-As: 1.12.0` trailer and wrote the manifest BACKWARDS from 2.5.0 to
 * 1.12.0 — rewriting package.json to match, so the manifest-vs-package.json
 * check above passed while both were 13 releases behind the live tag.
 */
describe("auditReleasePleaseManifest — changelog high-water mark", () => {
  const CONFIG = JSON.stringify({
    packages: { ".": { "changelog-path": "CHANGELOG.md" } },
  });

  test("fails when the manifest has gone BACKWARDS from what the changelog documents", () => {
    const root = makeRepo({
      ".release-please-manifest.json": JSON.stringify({ ".": "1.12.0" }),
      ".release-please-config.json": CONFIG,
      "package.json": JSON.stringify({ name: "nimbus", version: "1.12.0" }),
      "CHANGELOG.md":
        "# Changelog\n\n## [2.5.0](link) (2026-08-14)\n\n## [2.4.0](link) (2026-08-14)\n",
    });
    const result = auditReleasePleaseManifest(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("1.12.0");
    expect(result.errors[0]).toContain("2.5.0");
    expect(result.errors[0]).toContain("BEHIND");
  });

  test("passes when the manifest matches the newest documented version", () => {
    const root = makeRepo({
      ".release-please-manifest.json": JSON.stringify({ ".": "2.4.1" }),
      ".release-please-config.json": CONFIG,
      "package.json": JSON.stringify({ name: "nimbus", version: "2.4.1" }),
      "CHANGELOG.md":
        "# Changelog\n\n## [2.4.1](link) (2026-08-14)\n\n## [2.4.0](link) (2026-08-14)\n",
    });
    expect(auditReleasePleaseManifest(root)).toEqual({ ok: true, errors: [] });
  });

  // Between a release PR merging and its tag existing, the manifest is legitimately
  // one version ahead of everything already documented. Only BEHIND is drift.
  test("passes when the manifest is AHEAD of the changelog", () => {
    const root = makeRepo({
      ".release-please-manifest.json": JSON.stringify({ ".": "2.5.0" }),
      ".release-please-config.json": CONFIG,
      "package.json": JSON.stringify({ name: "nimbus", version: "2.5.0" }),
      "CHANGELOG.md": "# Changelog\n\n## [2.4.1](link) (2026-08-14)\n",
    });
    expect(auditReleasePleaseManifest(root).ok).toBe(true);
  });

  // 10.0.0 vs 9.9.9 must not be compared as strings, or the newer release reads as older.
  test("orders versions numerically, not lexically", () => {
    const root = makeRepo({
      ".release-please-manifest.json": JSON.stringify({ ".": "9.9.9" }),
      ".release-please-config.json": CONFIG,
      "package.json": JSON.stringify({ name: "nimbus", version: "9.9.9" }),
      "CHANGELOG.md": "# Changelog\n\n## [10.0.0](link) (2026-08-14)\n",
    });
    const result = auditReleasePleaseManifest(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("10.0.0");
  });

  test("skips the check for a package that has no changelog yet", () => {
    const root = makeRepo({
      ".release-please-manifest.json": JSON.stringify({ ".": "0.1.0" }),
      ".release-please-config.json": CONFIG,
      "package.json": JSON.stringify({ name: "nimbus", version: "0.1.0" }),
    });
    expect(auditReleasePleaseManifest(root).ok).toBe(true);
  });
});

describe("auditReleasePleaseManifest — extra-files", () => {
  const CONFIG = JSON.stringify({
    packages: { ".": { "extra-files": ["packages/gateway/src/version.ts"] } },
  });
  const base = (version: string) => ({
    ".release-please-manifest.json": JSON.stringify({ ".": version }),
    ".release-please-config.json": CONFIG,
    "package.json": JSON.stringify({ name: "nimbus", version }),
  });

  test("fails when an extra-file's annotated version was not bumped", () => {
    const root = makeRepo({
      ...base("2.4.1"),
      "packages/gateway/src/version.ts":
        'export const GATEWAY_VERSION = "1.12.0"; // x-release-please-version\n',
    });
    const result = auditReleasePleaseManifest(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("version.ts");
    expect(result.errors[0]).toContain("2.4.1");
  });

  test("passes when the annotated version matches the manifest", () => {
    const root = makeRepo({
      ...base("2.4.1"),
      "packages/gateway/src/version.ts":
        'export const GATEWAY_VERSION = "2.4.1"; // x-release-please-version\n',
    });
    expect(auditReleasePleaseManifest(root).ok).toBe(true);
  });

  // The real version.ts explains the annotation in its own header comment. An
  // earlier draft of this gate treated that prose as a bump site and failed
  // against a perfectly healthy tree.
  test("ignores a prose mention of the annotation that carries no version", () => {
    const root = makeRepo({
      ...base("2.4.1"),
      "packages/gateway/src/version.ts":
        "// Do not edit by hand — the `x-release-please-version` annotation drives it.\n" +
        'export const GATEWAY_VERSION = "2.4.1"; // x-release-please-version\n',
    });
    expect(auditReleasePleaseManifest(root)).toEqual({ ok: true, errors: [] });
  });

  test("fails when an extra-file has no annotated version line at all", () => {
    const root = makeRepo({
      ...base("2.4.1"),
      "packages/gateway/src/version.ts": 'export const GATEWAY_VERSION = "2.4.1";\n',
    });
    const result = auditReleasePleaseManifest(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("nothing to bump");
  });

  test("fails when a configured extra-file is missing from disk", () => {
    const root = makeRepo(base("2.4.1"));
    const result = auditReleasePleaseManifest(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("missing");
  });
});
