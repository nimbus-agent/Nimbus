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
