import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { auditActionShaPins, parseRootArg } from "./check-action-sha-pins.ts";

function makeRepo(layout: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "sha-pin-audit-"));
  for (const [relPath, contents] of Object.entries(layout)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf8");
  }
  return root;
}

const SHA = "a".repeat(40);

describe("auditActionShaPins", () => {
  test("passes when all third-party refs are SHA-pinned, exempting local + reusable refs", () => {
    const root = makeRepo({
      ".github/workflows/ci.yml": [
        "jobs:",
        "  build:",
        "    steps:",
        `      - uses: actions/checkout@${SHA} # v4`,
        "      - uses: ./.github/actions/setup-nimbus-ci",
        "      - uses: ./.github/workflows/_test-suite.yml",
        "      - uses: docker://alpine:3.20",
      ].join("\n"),
    });
    const result = auditActionShaPins(root);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("flags a tag-pinned ref", () => {
    const root = makeRepo({
      ".github/workflows/ci.yml": "    steps:\n      - uses: actions/checkout@v4\n",
    });
    const result = auditActionShaPins(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("actions/checkout@v4");
    expect(result.errors[0]).toContain("not SHA-pinned");
  });

  test("flags a ref with no @pin at all", () => {
    const root = makeRepo({
      ".github/actions/x/action.yml": "runs:\n  steps:\n    - uses: actions/checkout\n",
    });
    const result = auditActionShaPins(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("no @ref");
  });

  test("flags a short (non-40-hex) SHA", () => {
    const root = makeRepo({
      ".github/workflows/ci.yml": "    steps:\n      - uses: actions/checkout@abc1234\n",
    });
    const result = auditActionShaPins(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not SHA-pinned");
  });

  test("returns ok on a repo with no workflow dirs", () => {
    const result = auditActionShaPins(makeRepo({ "README.md": "# x" }));
    expect(result.ok).toBe(true);
  });
});

describe("parseRootArg", () => {
  test("defaults to cwd when --root is absent", () => {
    expect(parseRootArg([])).toBe(process.cwd());
  });

  test("returns the path following --root", () => {
    expect(parseRootArg(["--root", "/tmp/other-repo"])).toBe("/tmp/other-repo");
  });

  test("throws when --root is passed with no value", () => {
    expect(() => parseRootArg(["--root"])).toThrow("--root requires a path");
  });
});
